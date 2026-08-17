/**
 * Auto-pump coverage: the host-spawned root-agent supervisor that executes
 * tool-stage tasks without a human-parked pump session.
 *
 * Fakes follow boot.spec's shape (in-memory fs + scripted llm), plus three
 * captures the pump path needs: a fake `agents` registry (controllable
 * whenIdle gates), the registered `devflow` tool (reports are executed for
 * real through it), and the `session/event` handlers (ask_user_question
 * pending tracking). The service is the BUILT artifact — decorators are
 * lowered by the build pipeline, not by vitest's transform.
 *
 * @module @deepseek-ai/dsh-devflow/tests/pump
 */

import { clearInterval } from 'node:timers'
import { describe, expect, it } from 'vitest'
import { DevflowService } from '../lib/index.js'

interface FakeTarget {
  displayPath: string
}

/** One fake child spawn as the supervisor performed it. */
interface SpawnRecord {
  sessionId: string
  meta: { cwd?: string; agentPreset?: string }
  agentOptions: { provider?: string; model?: string }
  sandboxEvents: { type: string; data: unknown }[]
  followups: unknown[]
  cancelled: number
  disposed: number
  releaseIdle: () => void
}

/** Fake agents registry: records spawns, gates each run's whenIdle. */
function makeFakeAgents() {
  const spawns: SpawnRecord[] = []
  return {
    spawns,
    registry: {
      create: async (options: {
        sessionId: string
        meta?: { cwd?: string; agentPreset?: string }
        agentOptions?: { provider?: string; model?: string }
        setup?: (childCtx: unknown) => void | Promise<void>
      }): Promise<unknown> => {
        const record: SpawnRecord = {
          sessionId: options.sessionId,
          meta: options.meta ?? {},
          agentOptions: options.agentOptions ?? {},
          sandboxEvents: [],
          followups: [],
          cancelled: 0,
          disposed: 0,
          releaseIdle: () => undefined,
        }
        spawns.push(record)
        await options.setup?.({
          agent: {
            session: { append: (type: string, data: unknown) => { record.sandboxEvents.push({ type, data }) } },
          },
        })
        const idle = new Promise<void>(resolve => { record.releaseIdle = resolve })
        return {
          agent: {
            followup: (message: unknown) => { record.followups.push(message) },
            whenIdle: () => idle,
            cancel: () => { record.cancelled++ },
            session: { append: () => undefined },
          },
          dispose: async () => {
            record.disposed++
            record.releaseIdle()
          },
        }
      },
    },
  }
}

/** Minimal in-memory fs double (boot.spec's shape). */
function makeFakeFs(files: Map<string, string>): unknown {
  return {
    resolve: async (path: string): Promise<FakeTarget> => ({ displayPath: path }),
    listDir: async (target: FakeTarget) => {
      const dir = target.displayPath.replace(/\/+$/, '')
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (!key.startsWith(`${dir}/`)) continue
        const rest = key.slice(dir.length + 1)
        if (rest !== '') names.add(rest.split('/')[0])
      }
      const entries: { name: string, type: 'file' | 'directory', target: FakeTarget }[] = []
      for (const name of names) {
        entries.push({
          name,
          type: files.has(`${dir}/${name}`) ? 'file' : 'directory',
          target: { displayPath: `${dir}/${name}` },
        })
      }
      return entries
    },
    readText: async (target: FakeTarget) => {
      const content = files.get(target.displayPath)
      if (content === undefined) throw new Error('ENOENT')
      return content
    },
    writeText: async (target: FakeTarget, content: string) => {
      files.set(target.displayPath, content)
    },
  }
}

/** A scripted llm that finishes immediately with empty text. */
function idleLlm(): unknown {
  return {
    stream: (_options: unknown) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
}

/** An active item parked at the implement stage with the main workspace. */
function pumpableState(): string {
  return JSON.stringify({
    seq: 4,
    items: [{
      id: 'demo-abcd-r1',
      kind: 'requirement',
      raw: '原文',
      title: '演示需求',
      status: 'active',
      size: 'small',
      score: { value: 4, completeness: 4 },
      refined: { context: 'ctx', acceptance: [], scope: '' },
      questions: null,
      rejectReason: '',
      resumeTo: null,
      pipeline: {
        stage: 'implement',
        round: 0,
        waiting: null,
        error: null,
        pendingFix: null,
        answers: [],
        running: false,
        stageNote: null,
        workspace: { kind: 'main', path: '/ws/demo', branch: null },
        resourceWaiting: null,
        artifacts: {
          design: '# d', plan: '# p', reviews: [], impls: [], fixes: [], verifies: [], report: '',
        },
        files: {
          design: '/ws/demo/.devflow/artifacts/demo-abcd-r1-design.md',
          plan: '/ws/demo/.devflow/artifacts/demo-abcd-r1-plan.md',
          report: null,
        },
      },
      log: [],
    }],
    error: null,
    note: null,
    mainBusy: 'demo-abcd-r1',
    worktrees: [],
  })
}

/** Boot the service with the pump-relevant fakes wired through ctx.get. */
function bootService(options: {
  files: Map<string, string>
  agents?: ReturnType<typeof makeFakeAgents>['registry'] | undefined
}): {
  service: DevflowService
  tools: { name: string, execute: (args: unknown) => Promise<unknown> }[]
  handlers: Record<string, ((...args: unknown[]) => void) | undefined>
} {
  const tools: { name: string, execute: (args: unknown) => Promise<unknown> }[] = []
  const handlers: Record<string, ((...args: unknown[]) => void) | undefined> = {}
  const ctx = {
    fs: makeFakeFs(options.files),
    llm: idleLlm(),
    tools: { register: (def: { name: string, execute: (args: unknown) => Promise<unknown> }) => {
      tools.push(def)
      return () => undefined
    } },
    get: (key: string) => {
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p1', model: 'm1' }) }
      if (key === 'agents') return options.agents
      return undefined
    },
    // cordis semantics: effect(fn) invokes fn immediately and returns the
    // disposer — without the call, registerTool (and thus the devflow tool)
    // never runs under this fake.
    effect: (fn: () => unknown) => {
      fn()
      return () => undefined
    },
    logger: { error: () => undefined, info: () => undefined },
    on: (name: string, handler: (...args: unknown[]) => void) => {
      handlers[name] = handler
      return () => { delete handlers[name] }
    },
    reflect: { provide: () => undefined },
  }
  const service = new DevflowService(ctx as never, {
    root: '/ws/demo',
    maxActive: 3,
    maxWorktrees: 2,
    logCap: 40,
    tickIntervalMs: 500,
    pump: { maxConcurrent: 2 },
  })
  return { service, tools, handlers }
}

/** Poll a predicate (bounded wait). */
async function untilTrue(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 400; i++) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return check()
}

interface TimerHolder {
  timer?: ReturnType<typeof setInterval>
}

function stopService(service: DevflowService): void {
  const timer = (service as unknown as TimerHolder).timer
  if (timer !== undefined) clearInterval(timer)
}

function baseFiles(settings?: string): Map<string, string> {
  return new Map<string, string>([
    ['/ws/demo/.git/HEAD', 'ref: refs/heads/main'],
    ['/ws/demo/AGENTS.md', '# demo'],
    ['/ws/demo/.devflow/state.json', pumpableState()],
    ['/ws/demo/.devflow/settings.json', settings ?? '{"version":1,"stageModels":{},"pump":{"enabled":true,"model":""}}'],
  ])
}

function persistedItem(files: Map<string, string>): Record<string, unknown> | undefined {
  const raw = files.get('/ws/demo/.devflow/state.json')
  if (raw === undefined) return undefined
  const state = JSON.parse(raw) as { items: Record<string, unknown>[] }
  return state.items.find(candidate => candidate.id === 'demo-abcd-r1')
}

function pipelineOf(item: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return (item?.pipeline as Record<string, unknown> | undefined) ?? null
}

describe('devflow auto-pump', () => {
  it('spawns a root agent for a pumpable implement task when settings enable it', async () => {
    const agents = makeFakeAgents()
    const files = baseFiles()
    const { service } = bootService({ files, agents: agents.registry })
    try {
      const spawned = await untilTrue(() => agents.spawns.length > 0)
      expect(spawned).toBe(true)
      const spawn = agents.spawns[0]
      // The spawn recipe: root session at the project root, routed on the
      // harness-active model, pinned to workspace-write at creation.
      expect(spawn.meta.cwd).toBe('/ws/demo')
      expect(spawn.agentOptions).toEqual({ provider: 'p1', model: 'm1' })
      expect(spawn.sandboxEvents).toEqual([{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }])
      // The one-shot prompt embeds the task payload and the report contract.
      const prompt = JSON.stringify(spawn.followups)
      expect(prompt).toContain('demo-abcd-r1')
      expect(prompt).toContain('implement')
      // Spawn is logged onto the item.
      const logged = await untilTrue(() =>
        JSON.stringify(persistedItem(files)?.log ?? []).includes('自动泵已派出代理'))
      expect(logged).toBe(true)
      // The panel view projects the live run.
      const view = await service.state({ project: null })
      const viewed = view.items.find(i => i.id === 'demo-abcd-r1')
      expect(viewed?.pumpRunning).toBe(true)
      expect(viewed?.pumpSessionId).toBe(spawn.sessionId)
      expect(viewed?.note).toBe('自动泵执行中')
      expect(view.pump.enabled).toBe(true)
      expect(view.pump.available).toBe(true)
      expect(view.pump.activeCount).toBe(1)
    } finally {
      stopService(service)
    }
  })

  it('honors the settings pump model over the harness-active route', async () => {
    const agents = makeFakeAgents()
    const files = baseFiles('{"version":1,"stageModels":{},"pump":{"enabled":true,"model":"p2/m2"}}')
    const { service } = bootService({ files, agents: agents.registry })
    try {
      const spawned = await untilTrue(() => agents.spawns.length > 0)
      expect(spawned).toBe(true)
      expect(agents.spawns[0].agentOptions).toEqual({ provider: 'p2', model: 'm2' })
    } finally {
      stopService(service)
    }
  })

  it('marks the item waiting for the user while ask_user_question is pending', async () => {
    const agents = makeFakeAgents()
    const files = baseFiles()
    const { service, handlers } = bootService({ files, agents: agents.registry })
    try {
      const spawned = await untilTrue(() => agents.spawns.length > 0)
      expect(spawned).toBe(true)
      const emit = handlers['session/event']
      expect(emit).toBeDefined()
      const sessionId = agents.spawns[0].sessionId
      emit?.({ id: sessionId }, { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question' } })
      let view = await service.state({ project: null })
      let viewed = view.items.find(i => i.id === 'demo-abcd-r1')
      expect(viewed?.pumpWaitingUser).toBe(true)
      expect(viewed?.note).toBe('泵代理等待你的应答')
      // The answer clears the marker.
      emit?.({ id: sessionId }, {
        type: 'tool/result',
        data: { message: { content: [{ toolCallId: 'c1' }] } },
      })
      view = await service.state({ project: null })
      viewed = view.items.find(i => i.id === 'demo-abcd-r1')
      expect(viewed?.pumpWaitingUser).toBe(false)
    } finally {
      stopService(service)
    }
  })

  it('settles cleanly when the agent reported through the devflow tool', async () => {
    const agents = makeFakeAgents()
    const files = baseFiles()
    const { service, tools } = bootService({ files, agents: agents.registry })
    try {
      const spawned = await untilTrue(() => agents.spawns.length > 0)
      expect(spawned).toBe(true)
      const tool = tools.find(t => t.name === 'devflow')
      expect(tool).toBeDefined()
      // The child reports implement completion exactly like a real pump
      // session would — through the registered model tool.
      const result = await tool?.execute({
        action: 'report', itemId: 'demo-abcd-r1', summary: 'done', changedFiles: 'a.ts',
      }) as { text: string }
      expect(result.text).toContain('已回填')
      // Turn ends; the supervisor disposes and records nothing bad.
      agents.spawns[0].releaseIdle()
      const settled = await untilTrue(() => agents.spawns[0].disposed > 0)
      expect(settled).toBe(true)
      const pipe = pipelineOf(persistedItem(files))
      expect(pipe?.stage).toBe('code-review')
      expect(pipe?.error).toBeNull()
    } finally {
      stopService(service)
    }
  })

  it('surfaces a retryable error when the agent ends without reporting', async () => {
    const agents = makeFakeAgents()
    const files = baseFiles()
    const { service } = bootService({ files, agents: agents.registry })
    try {
      const spawned = await untilTrue(() => agents.spawns.length > 0)
      expect(spawned).toBe(true)
      agents.spawns[0].releaseIdle()
      const errored = await untilTrue(() => pipelineOf(persistedItem(files))?.error != null)
      expect(errored).toBe(true)
      const pipe = pipelineOf(persistedItem(files))
      expect(pipe?.stage).toBe('implement')
      expect(String(pipe?.error?.message)).toContain('未回填')
      // No auto-respawn: the sticky error parks the item for a manual retry
      // (an inert agent must not trigger a spawn loop on a broken model).
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(agents.spawns.length).toBe(1)
    } finally {
      stopService(service)
    }
  })

  it('does nothing and stays available=false when the host has no agents service', async () => {
    const files = baseFiles()
    const { service } = bootService({ files, agents: undefined })
    try {
      await new Promise(resolve => setTimeout(resolve, 60))
      const view = await service.state({ project: null })
      const viewed = view.items.find(i => i.id === 'demo-abcd-r1')
      expect(view.pump.available).toBe(false)
      expect(viewed?.pumpRunning).toBe(false)
      expect(viewed?.note).toBe('等待会话泵执行')
    } finally {
      stopService(service)
    }
  })

  it('does not spawn when the project settings leave the pump disabled', async () => {
    const agents = makeFakeAgents()
    const files = baseFiles('{"version":1,"stageModels":{}}')
    const { service } = bootService({ files, agents: agents.registry })
    try {
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(agents.spawns.length).toBe(0)
      const view = await service.state({ project: null })
      expect(view.pump.enabled).toBe(false)
      const viewed = view.items.find(i => i.id === 'demo-abcd-r1')
      expect(viewed?.note).toBe('等待会话泵执行')
    } finally {
      stopService(service)
    }
  })
})
