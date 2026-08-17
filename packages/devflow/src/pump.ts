/**
 * The auto-pump supervisor: drives tool-stage pipeline tasks through real
 * root agents spawned by the plugin host itself.
 *
 * Architectural boundary (decided against `ctx.subagents`): the subagent
 * seam composes children INSIDE a parent agent's initiator scope, which
 * makes them runtime-owned — `user-questions` then rejects their asks with
 * `DELEGATED_CALLER` (an owned child has no human answerer). Spawning from
 * the plugin's own background fiber instead publishes a runtime ROOT agent
 * (no initiator in scope), whose `ask_user_question` reaches the Web GUI
 * exactly like any human-opened session: the api-proxy provider broadcasts
 * `question/requested` to every connected client, and the client lights up
 * the sidebar for sessions never opened. That is the interaction contract
 * this module relies on.
 *
 * Per-task one-shot runs (fresh context each, failure isolation, natural
 * retry), a global lane budget, and best-effort session-event tracking for
 * the "waiting for the user's answer" marker. All agent-surface types are
 * structural slices — the pump must degrade to a visible "unavailable" in
 * compositions without the agents service (tests, minimal hosts) rather
 * than hard-inject it.
 *
 * @module @deepseek-ai/dsh-devflow/src/pump
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { DevflowPumpTask } from './types.ts'

/** Structural slice of `ctx.agents` (absent → auto-pump unavailable). */
interface AgentsFace {
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string }
    setup?: (childCtx: Context) => void | Promise<void>
  }): Promise<AgentHandleFace>
}

/** Structural slice of one owned agent handle. */
interface AgentHandleFace {
  readonly agent: AgentFace
  dispose(): Promise<void>
}

/** Structural slice of one live agent's drive surface. */
interface AgentFace {
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel(options?: unknown): void
  readonly session: { append(type: string, data: unknown): void }
}

/** Structural slice of `ctx.agentPresets` (optional per deployment). */
interface AgentPresetsFace {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Host callbacks the supervisor needs; implemented by DevflowService. */
export interface PumpHost {
  /** Resolve the model route for one task's spawn (null → skip loudly). */
  modelRoute(projectKey: string): Promise<{ provider: string; model: string } | null>
  /** Build the one-shot prompt for a task (payload embedded). */
  promptFor(task: DevflowPumpTask): string
  /** Best-effort log line when a run starts (with the child session id). */
  onSpawned(task: DevflowPumpTask, sessionId: string): void
  /** Evaluate one settled run against durable state and log/persist. */
  onSettled(task: DevflowPumpTask, outcome: PumpOutcome): Promise<void>
}

/** What a settled run reports back to the host. */
export interface PumpOutcome {
  readonly sessionId: string
  /** True when the run ended through the panel's interrupt / teardown. */
  readonly cancelled: boolean
  /** Failure text when the run never reached a turn (spawn/驱动 error). */
  readonly failure: string | null
}

/** Per-item pump status projected into the panel view. */
export interface PumpItemStatus {
  readonly running: boolean
  readonly waitingUser: boolean
  readonly sessionId: string | null
}

/** One in-flight (or reserving) one-shot run. */
interface PumpRun {
  readonly task: DevflowPumpTask
  readonly sessionId: string
  handle: AgentHandleFace | null
  /** ask_user_question callIds without a matching tool/result yet. */
  readonly asks: Set<string>
  cancelled: boolean
}

/**
 * Global supervisor over every project partition. Lanes are process-wide:
 * the per-project settings decide WHO auto-pumps and with which model, the
 * deployment config caps HOW MANY run at once.
 */
export class PumpSupervisor {
  private readonly runs = new Map<string, PumpRun>()
  private readonly bySession = new Map<string, PumpRun>()
  private readonly disposeEvents: () => void
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly host: PumpHost,
  ) {
    // ask_user_question pending tracking: pair `tool/call` with
    // `tool/result` by call id. The marker is process-local observability
    // (the question itself already travels through the GUI's own channel);
    // losing it on restart only loses the badge, never the interaction.
    this.disposeEvents = ctx.on('session/event', (session: { id: string }, event: { type: string; data: unknown }) => {
      const run = this.bySession.get(session.id)
      if (run === undefined) return
      if (event.type === 'tool/call') {
        const data = event.data as { callId?: unknown; name?: unknown }
        if (data.name === 'ask_user_question' && typeof data.callId === 'string') run.asks.add(data.callId)
      } else if (event.type === 'tool/result') {
        const data = event.data as { message?: { content?: readonly { toolCallId?: unknown }[] } }
        const block = data.message?.content?.[0]
        if (block !== undefined && typeof block.toolCallId === 'string') run.asks.delete(block.toolCallId)
      }
    })
  }

  /** Whether the host assembled the agents service at all. */
  available(): boolean {
    return this.ctx.get('agents') !== undefined
  }

  /** Live run count (lane occupancy). */
  runningCount(): number {
    return this.runs.size
  }

  /** Per-item projection for the panel view. */
  statusOf(itemId: string): PumpItemStatus {
    const run = this.runs.get(itemId)
    if (run === undefined) return { running: false, waitingUser: false, sessionId: null }
    return { running: true, waitingUser: run.asks.size > 0, sessionId: run.sessionId }
  }

  /**
   * Reserve a lane and drive one task. Synchronous up to the reservation
   * (so overlapping ticks cannot double-spawn one item); creation and the
   * one-shot turn then run detached, and every path releases the lane.
   * @param task - the pumpable task payload.
   * @returns true when a lane was reserved for this call.
   */
  spawn(task: DevflowPumpTask): boolean {
    if (this.disposed || this.runs.has(task.itemId)) return false
    const agents = this.ctx.get('agents') as AgentsFace | undefined
    if (agents === undefined) return false
    const run: PumpRun = { task, sessionId: randomUUID(), handle: null, asks: new Set(), cancelled: false }
    this.runs.set(task.itemId, run)
    this.bySession.set(run.sessionId, run)
    void this.drive(run, agents)
    return true
  }

  /** Interrupt one item's run (panel「中断」); the settle path stays graceful. */
  kill(itemId: string): void {
    const run = this.runs.get(itemId)
    if (run === undefined) return
    run.cancelled = true
    // Pre-publication: the drive loop checks the flag at its next
    // checkpoint and releases without ever following up.
    if (run.handle !== null) run.handle.agent.cancel({ kind: 'parent' })
  }

  /** Service teardown: cancel and drain every live run, drop the listener. */
  disposeAll(): void {
    this.disposed = true
    this.disposeEvents()
    for (const run of this.runs.values()) {
      run.cancelled = true
      run.handle?.agent.cancel({ kind: 'parent' })
    }
    for (const run of [...this.runs.values()]) {
      const handle = run.handle
      if (handle === null) continue // still creating; drive() will see cancelled
      void handle.dispose().catch(() => undefined).then(() => {
        this.runs.delete(run.task.itemId)
        this.bySession.delete(run.sessionId)
      })
    }
  }

  /**
   * Create → drive → settle one run. Every failure path funnels into the
   * same settle step so the lane is always released and the host always
   * gets exactly one onSettled per spawn.
   */
  private async drive(run: PumpRun, agents: AgentsFace): Promise<void> {
    let failure: string | null = null
    try {
      // The GUI's own composition recipe (api-proxy composeAgent): resolve
      // the deployment-default preset first so its id can be recorded in
      // the durable meta, then mount it inside the unpublished creation
      // window. Rosterless deployments skip the join — the global layer
      // already carries the model-facing rows there.
      const presets = this.ctx.get('agentPresets') as AgentPresetsFace | undefined
      let presetId: string | undefined
      if (presets !== undefined) presetId = (await presets.resolve()).id
      const route = await this.host.modelRoute(run.task.project)
      if (route === null) {
        throw new Error('无可用的模型路由（未配置泵模型且 harness 无当前模型）')
      }
      const appendSandbox = (childCtx: Context): void => {
        // Pin the child to workspace-write at its session cwd (= the
        // project root): the pipeline's only sanctioned write boundary.
        // Approval stays unpinned — asks route to the GUI by design.
        const agent = (childCtx as { agent?: AgentFace }).agent
        agent?.session.append('sandbox/mode', { mode: 'workspace-write' })
      }
      const handle = await agents.create({
        sessionId: run.sessionId,
        meta: {
          cwd: run.task.projectRoot,
          ...presetId !== undefined ? { agentPreset: presetId } : {},
        },
        agentOptions: { provider: route.provider, model: route.model },
        setup: async (childCtx: Context) => {
          if (presets !== undefined && presetId !== undefined) await presets.mount(childCtx, presetId)
          appendSandbox(childCtx)
        },
      })
      run.handle = handle
      // Killed during creation: skip the turn entirely (no spawn log, no
      // followup) and fall through to settle — an early `return` inside the
      // try would leapfrog settle and leak the lane.
      if (!run.cancelled) {
        this.host.onSpawned(run.task, run.sessionId)
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: this.host.promptFor(run.task) }],
          source: { kind: 'user' },
        }))
        await handle.agent.whenIdle()
      }
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : JSON.stringify(error)
    }
    await this.settle(run, failure)
  }

  /** Release the lane, dispose the agent, then hand evaluation to the host. */
  private async settle(run: PumpRun, failure: string | null): Promise<void> {
    if (run.handle !== null) {
      try {
        await run.handle.dispose()
      } catch {
        // best effort: the registry's own teardown covers a stuck child
      }
    }
    this.runs.delete(run.task.itemId)
    this.bySession.delete(run.sessionId)
    try {
      await this.host.onSettled(run.task, {
        sessionId: run.sessionId,
        cancelled: run.cancelled,
        failure,
      })
    } catch {
      // host evaluation is best-effort; the lane is already released
    }
  }
}

/** The one-shot prompt handed to a spawned pump agent. */
export function buildPumpPrompt(task: DevflowPumpTask): string {
  return [
    '你是 dsh-devflow 自动开发流水线的泵代理，负责执行一项需要真实工具能力的开发任务。任务载荷（JSON）：',
    JSON.stringify(task, null, 1),
    '',
    '执行规则：',
    '1. 按 hint 指引在指定工作区完成任务（读设计/计划文件、改代码、跑检查、验证、合并等），遵守项目 AGENTS.md 规范。',
    '2. 遇到只有人类才能拍板的决策（方案取舍、密钥凭据、破坏性操作等），优先调用 ask_user_question 工具提问：给出选项与推荐，等待答复后继续。你运行在一个独立真实会话里，用户会在 Web 界面收到提问（侧栏该会话亮起待答标记）。',
    '3. 若 ask_user_question 不可用或报错，退回：调用 devflow 工具 action=report，itemId 填本任务 itemId，questions 填 JSON 数组 [{"q":"","options":[{"label":"","desc":""}],"recommend":""}]，然后结束。',
    '4. 任务完成后调用 devflow 工具 action=report 回填：implement/fix-code → summary+changedFiles（相对仓库根、逗号分隔）；verify/merge → verified="true"/"false"+detail。',
    '5. 回填被接受后，用一段简短中文总结结束回复。不要调用 devflow 的 action=next（任务已直接交付给你）；不要派生子代理；不要改动 .devflow/ 运行时状态目录。',
  ].join('\n')
}
