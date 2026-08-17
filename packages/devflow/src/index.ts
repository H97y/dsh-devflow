/**
 * Automated development pipeline host service: a persistent requirement pool
 * with LLM-driven refine → design → plan → review/fix (≤3 rounds) stages,
 * per-stage waiting queues for decisions only a human can make, and a
 * session-pumped tool phase (implement / fix-code / verify / merge) whose
 * tasks carry workspace routing — small items on the main workspace, larger
 * ones on dedicated worktrees merged back through an integration branch.
 *
 * The panel reaches this service through generated Remotes (state/submit/
 * answer/cancel/resume/retry/artifact/prompts/prompt-set); the model reaches
 * it through the `devflow` tool (next/report). All durable state lives under
 * `<root>/.devflow/` as lossless JSON.
 *
 * @module @deepseek-ai/dsh-devflow
 */

import { clearInterval, setInterval } from 'node:timers'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_PROMPTS, PROMPT_VARS, renderPrompt } from './prompts.ts'
import type { DevflowPromptStage } from './prompts.ts'
import type {
  DevflowAnswerRequest, DevflowArtifactRequest, DevflowItem, DevflowIssue, DevflowItemView, DevflowScore,
  DevflowMutationResult, DevflowPipeline, DevflowPromptSetRequest, DevflowPromptsView,
  DevflowPumpTask, DevflowQuestion, DevflowReportArgs, DevflowStage, DevflowState,
  DevflowSubmitRequest, DevflowSubmitResult, DevflowView,
} from './types.ts'

export type * from './types.ts'
export { DEFAULT_PROMPTS, PROMPT_VARS, renderPrompt } from './prompts.ts'
export type { DevflowPromptStage } from './prompts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The automated development pipeline service. */
    devflow: DevflowService
  }
}

/** Deployment configuration for the pipeline. */
export interface Config {
  /** Workspace root: `.devflow/` state and the small-item workspace live here. */
  readonly root: string
  /** Maximum concurrently active pipelines. */
  readonly maxActive: number
  /** Maximum concurrently allocated worktrees. */
  readonly maxWorktrees: number
  /** Per-item log cap; older lines are dropped. */
  readonly logCap: number
  /** State-machine tick interval in milliseconds. */
  readonly tickIntervalMs: number
}

/** Schemastery validation with deployment defaults. */
export const Config: s<Config> = s.object({
  root: s.string().default(process.cwd()),
  maxActive: s.number().step(1).min(1).default(3),
  maxWorktrees: s.number().step(1).min(0).default(2),
  logCap: s.number().step(1).min(5).default(40),
  tickIntervalMs: s.number().step(100).min(500).default(2000),
})

/** Stages advanced by background LLM calls (their prompt keys mirror these). */
const AUTO_STAGES: Partial<Record<DevflowStage, DevflowPromptStage>> = {
  design: 'design',
  plan: 'plan',
  'review-dp': 'reviewDp',
  'code-review': 'codeReview',
  report: 'report',
}

/** Stages executed by the session through the `devflow` tool. */
const PUMP_STAGES: readonly DevflowStage[] = ['implement', 'fix-code', 'verify', 'merge']

/** Human-readable progress note per auto stage. */
const STAGE_NOTES: Partial<Record<DevflowStage, string>> = {
  design: '正在生成设计文档',
  plan: '正在生成实施计划',
  'review-dp': '评审设计/计划',
  'code-review': '代码评审中',
  report: '正在生成开发报告',
}

/** Clip text to a bound with an ellipsis. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** The admission weight of one refinement score. */
function weight(score: DevflowScore): number {
  return score.value * 0.6 + score.completeness * 0.4
}

/** Render an unknown catch/error value as short text without String(anything). */
function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** Coerce one model-JSON field to text with a fallback. */
function asText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Coerce one model-JSON field to a string array. */
function asTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Coerce one model-JSON field to a question list. */
function asQuestions(value: unknown): DevflowQuestion[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is DevflowQuestion => typeof v === 'object' && v !== null)
}

/** Coerce one model-JSON field to an issue list. */
function asIssues(value: unknown): DevflowIssue[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is DevflowIssue => typeof v === 'object' && v !== null)
}

/** Whether one abortable call was cancelled through the panel. */
class Cancelled extends Error {
  constructor() {
    super('devflow: cancelled by user')
    this.name = 'Cancelled'
  }
}

/**
 * The pipeline service. One process-local tick loop owns every state
 * mutation; a busy flag serializes ticks, and per-call AbortControllers
 * forward panel cancels into in-flight model streams.
 */
export class DevflowService extends TypertRemoteService {
  static inject = ['llm', 'fs', 'tools']

  private readonly root: string
  private readonly dir: string
  private readonly policy: SandboxExecutionPolicy
  private readonly maxActive: number
  private readonly maxWorktrees: number
  private readonly logCap: number
  private store: DevflowState | null = null
  private loading: Promise<void> | null = null
  private busy = false
  private cooldown = 0
  private customPrompts: Record<string, string> = {}
  private activeController: AbortController | null = null
  private cancelRequestedId: string | null = null
  private readonly timer: ReturnType<typeof setInterval>

  /**
   * @param ctx - Host context carrying llm/fs/tools.
   * @param config - Deployment configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'devflow')
    this.root = config.root
    this.dir = `${config.root}/.devflow`
    this.policy = { mode: 'workspace-write', workspaceRoot: config.root }
    this.maxActive = config.maxActive
    this.maxWorktrees = config.maxWorktrees
    this.logCap = config.logCap
    this.timer = setInterval(() => { void this.tick() }, config.tickIntervalMs)
    ctx.effect(() => () => { clearInterval(this.timer) }, 'devflow.tickTimer')
    ctx.effect(() => this.registerTool(config), 'devflow.tool')
  }

  /** Whole-state projection the panel polls. */
  @Remote('state')
  async state(): Promise<DevflowView> {
    await this.ensureLoaded()
    return this.project()
  }

  /** Drop one raw requirement or bug into the pool. */
  @Remote('submit')
  async submit(request: DevflowSubmitRequest): Promise<DevflowSubmitResult> {
    await this.ensureLoaded()
    const state = this.requireState()
    const text = request.text.trim()
    if (text.length === 0) throw new Error('devflow: requirement text is empty')
    const item: DevflowItem = {
      id: `r${state.seq++}`,
      kind: request.kind === 'bug' ? 'bug' : 'requirement',
      raw: text,
      title: clip(text, 40),
      status: 'raw',
      size: null,
      score: null,
      refined: null,
      questions: null,
      rejectReason: '',
      resumeTo: null,
      pipeline: null,
      log: [{ n: state.seq++, note: '投入需求池' }],
    }
    state.items.push(item)
    await this.save()
    this.kick()
    return { ok: true, id: item.id }
  }

  /** Answer waiting-queue or refinement questions. */
  @Remote('answer')
  async answer(request: DevflowAnswerRequest): Promise<DevflowMutationResult> {
    await this.ensureLoaded()
    const item = this.findItem(request.itemId)
    if (item.status === 'needs-user') {
      const refined = item.refined ?? { context: item.raw, acceptance: [], scope: '' }
      refined.context += `\n【用户补充】${request.answers.map(a => `${a.q} → ${a.a}`).join('；')}`
      item.refined = refined
      item.status = 'ready'
      item.questions = null
      this.log(item, '用户补充完成，重新进入可选池')
    } else if (item.status === 'active') {
      const pipe = this.pipe(item)
      if (pipe.waiting === null
        || (request.stage !== null && pipe.waiting.stage !== request.stage)) {
        throw new Error('devflow: item is not waiting for these answers')
      }
      pipe.answers.push(...request.answers)
      pipe.waiting = null
      this.log(item, `用户已决策，继续阶段 ${pipe.stage}`)
    } else {
      throw new Error(`devflow: item status ${item.status} accepts no answers`)
    }
    await this.save()
    this.kick()
    return { ok: true }
  }

  /** Interrupt execution or collapse a waiting entry into a real pause. */
  @Remote('cancel')
  async cancel(request: { itemId: string }): Promise<DevflowMutationResult> {
    await this.ensureLoaded()
    const item = this.findItem(request.itemId)
    if (item.status === 'needs-user') {
      item.status = 'paused'
      item.resumeTo = 'needs-user'
      this.log(item, '已暂停（问题已收起，继续时重新展示）')
    } else if (item.status === 'refining') {
      this.abortActive(item.id)
      item.status = 'paused'
      item.resumeTo = 'raw'
      this.log(item, '已中断精炼并暂停')
    } else if (item.status === 'active') {
      this.abortActive(item.id)
      const pipe = this.pipe(item)
      const released = pipe.workspace?.kind
      this.release(item)
      pipe.waiting = null
      pipe.running = false
      pipe.stageNote = null
      item.status = 'paused'
      item.resumeTo = 'ready'
      this.log(item, `已中断并暂停（断点·${pipe.stage}${released !== undefined ? `，已释放${released === 'main' ? '主工作区' : 'worktree'}` : ''}，进度保留）`)
    } else {
      return { ok: false, reason: `当前状态（${item.status}）无需中断` }
    }
    await this.save()
    this.kick()
    return { ok: true }
  }

  /** Resume a paused item back into its pre-interruption lane. */
  @Remote('resume')
  async resume(request: { itemId: string }): Promise<DevflowMutationResult> {
    await this.ensureLoaded()
    const item = this.findItem(request.itemId)
    if (item.status !== 'paused') return { ok: false, reason: '该需求不在暂停状态' }
    const to = item.resumeTo ?? 'ready'
    item.status = to === 'needs-user' || to === 'raw' ? to : 'ready'
    item.resumeTo = null
    this.log(item, '用户恢复，继续流程')
    await this.save()
    this.kick()
    return { ok: true }
  }

  /** Clear one item's sticky stage error (or refine cooldown). */
  @Remote('retry')
  async retry(request: { itemId: string }): Promise<DevflowMutationResult> {
    await this.ensureLoaded()
    const item = this.findItem(request.itemId)
    if (item.pipeline?.error != null) {
      item.pipeline.error = null
      this.log(item, '用户触发重试')
      await this.save()
    }
    if (item.status === 'refining' || item.status === 'raw') {
      this.requireState().error = null
      this.cooldown = 0
    }
    this.kick()
    return { ok: true }
  }

  /** Read one artifact's (clipped) text for the panel viewer. */
  @Remote('artifact')
  async artifact(request: DevflowArtifactRequest): Promise<string> {
    await this.ensureLoaded()
    const item = this.findItem(request.itemId)
    if (item.pipeline === null) throw new Error('devflow: item has no artifacts')
    const artifacts = item.pipeline.artifacts
    switch (request.name) {
      case 'design': return clip(artifacts.design, 8000)
      case 'plan': return clip(artifacts.plan, 8000)
      case 'report': return clip(artifacts.report, 8000)
      case 'reviews': return clip(JSON.stringify(artifacts.reviews, null, 1), 8000)
    }
  }

  /** Prompt-template directory: defaults plus the user's overrides. */
  @Remote('prompts')
  async prompts(): Promise<DevflowPromptsView> {
    await this.ensureLoaded()
    return { custom: this.customPrompts, defaults: DEFAULT_PROMPTS, vars: PROMPT_VARS }
  }

  /** Set (or clear with null) one stage's custom template. */
  @Remote('prompt-set')
  async promptSet(request: DevflowPromptSetRequest): Promise<DevflowMutationResult> {
    await this.ensureLoaded()
    if (!(request.stage in DEFAULT_PROMPTS)) throw new Error(`devflow: unknown prompt stage ${request.stage}`)
    if (request.template === null || request.template.trim() === '') {
      this.customPrompts = Object.fromEntries(
        Object.entries(this.customPrompts).filter(([key]) => key !== request.stage),
      )
    } else {
      this.customPrompts[request.stage] = request.template
    }
    await this.writeFile('prompts.json', JSON.stringify(this.customPrompts, null, 2))
    return { ok: true }
  }

  /** Register the session-facing task pump tool. */
  private registerTool(_config: Config): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'devflow',
      description: '自动开发流水线任务泵：LLM文本阶段（需求精炼/设计/计划/评审/报告）由插件后台自动推进，'
        + '无需本工具；本工具只服务需要工具能力的阶段（implement/fix-code/verify/merge，'
        + '任务带工作区路由：小需求主工作区、中大需求worktree，merge为集成分支合并回main）。'
        + 'action=next 获取下一个待执行任务；action=report 回填任务结果推进流水线。',
      parameters: {
        action: { type: 'string', required: true, description: 'next | report' },
        itemId: { type: 'string', description: 'report 时目标需求 id' },
        summary: { type: 'string', description: 'report 时结果摘要（markdown）' },
        changedFiles: { type: 'string', description: 'report 时改动文件，逗号分隔' },
        verified: { type: 'string', description: 'verify/merge 任务时填 true/false' },
        detail: { type: 'string', description: '验证步骤记录 / 合并冲突解决记录 / 失败原因等细节' },
        questions: { type: 'string', description: '需用户决策时填 JSON 数组 [{"q":"","options":[{"label":"","desc":""}],"recommend":""}]' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: (_args, value: { text: string }) => [{ type: 'text', text: value.text }],
      },
      execute: async (args: DevflowReportArgs) => {
        await this.ensureLoaded()
        if (args.action === 'next') return { text: this.describeNextTask() }
        return await this.acceptReport(args)
      },
    }))
  }

  /** One state-machine beat: refine, admit, allocate, advance one auto stage. */
  private async tick(): Promise<void> {
    if (this.busy) return
    // 互斥须覆盖 ensureLoaded 阶段：否则上一跳仍在加载 store 时，
    // 下一跳已越过 busy 检查闯入状态机主体
    this.busy = true
    try {
      await this.ensureLoaded()
      if (this.cooldown > 0) {
        this.cooldown--
        return
      }
      const state = this.requireState()
      if (state.items.some(i => i.status === 'raw' || i.status === 'refining')) {
        await this.withAbort(async () => this.runRefine(), (error) => {
          if (this.cancelRequestedId !== null) {
            for (const item of state.items) if (item.status === 'refining') item.status = 'raw'
            this.cancelRequestedId = null
            state.error = null
            this.cooldown = 0
          } else {
            state.error = `精炼失败: ${error.message}`
            this.cooldown = 30
          }
          state.note = null
        })
        await this.save()
        return
      }
      while (this.activeItems().length < this.maxActive
        && state.items.some(i => i.status === 'ready' && i.score !== null)) {
        const best = this.pickBest()
        best.status = 'active'
        this.log(best, `被选中进入流水线（价值${best.score.value}/完整${best.score.completeness}）`)
        await this.save()
      }
      let allocChanged = false
      for (const item of this.activeItems()) {
        const pipe = this.pipe(item)
        if (PUMP_STAGES.includes(pipe.stage) && pipe.workspace === null && pipe.resourceWaiting === null) {
          if (this.tryAllocate(item)) allocChanged = true
        }
      }
      if (allocChanged) await this.save()
      const target = this.activeItems().find((item) => {
        const pipe = this.pipe(item)
        return pipe.waiting === null && pipe.error === null && !pipe.running
          && AUTO_STAGES[pipe.stage] !== undefined
      })
      if (target === undefined) return
      const pipe = this.pipe(target)
      pipe.running = true
      pipe.stageNote = pipe.stage === 'review-dp'
        ? `评审设计/计划 第${pipe.round + 1}轮`
        : STAGE_NOTES[pipe.stage] ?? pipe.stage
      await this.save()
      try {
        await this.runAutoStage(target)
      } finally {
        this.activeController = null
        pipe.running = false
        pipe.stageNote = null
      }
      await this.save()
    } catch (error) {
      await this.recordTickFailure(error)
    } finally {
      this.busy = false
    }
  }

  /** Run an abortable block, routing cancellation vs failure to the handler. */
  private async withAbort(
    run: () => Promise<void>,
    onFailure: (error: Error) => void,
  ): Promise<void> {
    this.activeController = new AbortController()
    try {
      await run()
    } catch (error) {
      onFailure(error instanceof Error ? error : new Error(describeUnknown(error)))
    } finally {
      this.activeController = null
    }
  }

  /** Persist a stage failure onto the running item unless it was intentional. */
  private async recordTickFailure(error: unknown): Promise<void> {
    // state 尚未加载时无法落盘任何失败信息，只记日志；
    // 这里再抛错会把可恢复的 tick 失败放大成进程级 fatal
    if (this.store === null) {
      this.ctx.logger.error('devflow: tick failed before state loaded: %s', describeUnknown(error))
      return
    }
    const running = this.requireState().items.find(i => i.status === 'active' && i.pipeline?.running === true)
    const intentional = running !== undefined && this.cancelRequestedId === running.id
    this.cancelRequestedId = null
    try {
      if (running !== undefined && !intentional) {
        const pipe = this.pipe(running)
        pipe.error = { stage: pipe.stage, message: describeUnknown(error) }
        this.log(running, `阶段${pipe.stage}出错: ${pipe.error.message}`)
      }
      await this.save()
    } catch (nested) {
      this.ctx.logger.error('devflow: failed to record tick failure: %s', describeUnknown(nested))
    }
  }

  /** Dispatch one item's current auto stage. */
  private async runAutoStage(item: DevflowItem): Promise<void> {
    const stage = this.pipe(item).stage
    switch (stage) {
      case 'design': return this.runDesign(item)
      case 'plan': return this.runPlan(item)
      case 'review-dp': return this.runReviewDp(item)
      case 'code-review': return this.runReviewCode(item)
      case 'report': return this.runReport(item)
      default: throw new Error(`devflow: stage ${stage} is not automatic`)
    }
  }

  /** Batch-refine every raw item: enrich, score, size, and triage. */
  private async runRefine(): Promise<void> {
    const state = this.requireState()
    const batch = state.items.filter(i => i.status === 'raw' || i.status === 'refining')
    if (batch.length === 0) return
    for (const item of batch) item.status = 'refining'
    state.error = null
    state.note = `正在精炼 ${batch.length} 条需求（调用模型）`
    await this.save()
    const user = renderPrompt('refine', this.customPrompts, {
      repo: await this.repoContext(),
      batch: JSON.stringify(batch.map(i => ({ id: i.id, kind: i.kind, raw: i.raw })), null, 1),
    })
    const output = this.parseJson(await this.chat(user))
    const byId = new Map<string, Record<string, unknown>>()
    for (const row of (output.items as Record<string, unknown>[] | undefined) ?? []) {
      byId.set(String(row.id), row)
    }
    for (const item of batch) {
      const row = byId.get(item.id)
      if (row === undefined) {
        item.status = 'raw'
        this.log(item, '精炼未返回，退回待精炼')
        continue
      }
      item.title = clip(asText(row.title, item.title), 60)
      item.size = row.size === 'medium' || row.size === 'large' ? row.size : 'small'
      item.score = {
        value: typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : 0,
        completeness: typeof row.completeness === 'number' && Number.isFinite(row.completeness) ? row.completeness : 0,
      }
      item.refined = {
        context: asText(row.context, item.raw),
        acceptance: asTextArray(row.acceptance),
        scope: asText(row.scope, ''),
      }
      const questions = asQuestions(row.questions)
      if (row.reject === true || item.score.value <= 2) {
        item.status = 'rejected'
        item.rejectReason = asText(row.reason, '价值过低')
        this.log(item, `判定搁置: ${item.rejectReason}`)
      } else if (row.incomplete === true && questions.length > 0) {
        item.status = 'needs-user'
        item.questions = questions
        this.log(item, '待用户补充意图')
      } else {
        item.status = 'ready'
        this.log(item, `精炼完成（规模${item.size === 'small' ? '小' : item.size === 'medium' ? '中' : '大'}），进入可选池`)
      }
    }
    state.note = null
  }

  /** Produce the design document. */
  private async runDesign(item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const output = this.parseJson(await this.chat(renderPrompt('design', this.customPrompts, {
      repo: await this.repoContext(),
      requirement: this.requirementJson(item),
      answers: this.answersText(pipe),
    })))
    pipe.artifacts.design = asText(output.design, '')
    pipe.files.design = await this.writeFile(`artifacts/${item.id}-design.md`, pipe.artifacts.design)
    const questions = asQuestions(output.questions)
    if (questions.length > 0) {
      pipe.waiting = { stage: 'design', questions }
      this.log(item, '设计产出，有必须用户决策项')
    } else {
      pipe.stage = 'plan'
      this.log(item, '设计完成')
    }
  }

  /** Produce the implementation plan. */
  private async runPlan(item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const output = this.parseJson(await this.chat(renderPrompt('plan', this.customPrompts, {
      requirement: this.requirementJson(item),
      design: pipe.artifacts.design,
      answers: this.answersText(pipe),
    })))
    pipe.artifacts.plan = asText(output.plan, '')
    pipe.files.plan = await this.writeFile(`artifacts/${item.id}-plan.md`, pipe.artifacts.plan)
    const questions = asQuestions(output.questions)
    if (questions.length > 0) {
      pipe.waiting = { stage: 'plan', questions }
      this.log(item, '计划产出，有必须用户决策项')
    } else {
      pipe.stage = 'review-dp'
      pipe.round = 0
      this.log(item, '计划完成，进入设计/计划评审')
    }
  }

  /** Review design+plan; pass, escalate to the user, or revise and re-review. */
  private async runReviewDp(item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const output = this.parseJson(await this.chat(renderPrompt('reviewDp', this.customPrompts, {
      requirement: this.requirementJson(item),
      design: pipe.artifacts.design,
      plan: pipe.artifacts.plan,
      answers: this.answersText(pipe),
    })))
    pipe.round++
    const issues = asIssues(output.issues)
    pipe.artifacts.reviews.push({ phase: 'dp', round: pipe.round, verdict: asText(output.verdict, ''), issues })
    const questions = asQuestions(output.questions)
    if (questions.length > 0) {
      pipe.waiting = { stage: 'review-dp', questions }
      this.log(item, `评审第${pipe.round}轮提出用户决策`)
      return
    }
    if (output.verdict === 'pass' || pipe.round >= 3) {
      if (output.verdict !== 'pass') this.log(item, '评审3轮未全清，遗留问题记入报告')
      pipe.stage = 'implement'
      pipe.round = 0
      pipe.pendingFix = null
      this.log(item, `设计/计划评审通过，进入实施（规模${item.size === 'medium' || item.size === 'large' ? '中大·worktree' : '小·主工作区'}）`)
      return
    }
    await this.fixDesignAndPlan(item, issues)
  }

  /** Revise design and plan to resolve review issues. */
  private async fixDesignAndPlan(item: DevflowItem, issues: DevflowPipeline['pendingFix']): Promise<void> {
    const pipe = this.pipe(item)
    const issuesJson = JSON.stringify(issues, null, 1)
    const designOut = this.parseJson(await this.chat(renderPrompt('fixDesign', this.customPrompts, {
      design: pipe.artifacts.design,
      issues: issuesJson,
    })))
    if (typeof designOut.doc === 'string' && designOut.doc !== '') {
      pipe.artifacts.design = designOut.doc
      pipe.files.design = await this.writeFile(`artifacts/${item.id}-design.md`, designOut.doc)
    }
    const planOut = this.parseJson(await this.chat(renderPrompt('fixPlan', this.customPrompts, {
      design: clip(pipe.artifacts.design, 6000),
      plan: pipe.artifacts.plan,
      issues: issuesJson,
    })))
    if (typeof planOut.doc === 'string' && planOut.doc !== '') {
      pipe.artifacts.plan = planOut.doc
      pipe.files.plan = await this.writeFile(`artifacts/${item.id}-plan.md`, planOut.doc)
    }
    this.log(item, '按评审意见修订了设计与计划')
  }

  /** Review the implemented diff set; pass, escalate, or queue fixes. */
  private async runReviewCode(item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const impl = pipe.artifacts.impls.at(-1) ?? null
    const lastFix = pipe.artifacts.fixes.at(-1) ?? null
    const changed: string[] = []
    for (const record of [...pipe.artifacts.impls, ...pipe.artifacts.fixes]) {
      for (const file of record.changedFiles) if (!changed.includes(file)) changed.push(file)
    }
    let filesText = ''
    for (const file of changed.slice(0, 8)) {
      try {
        const content = await this.ctx.fs.readText(await this.resolve(`${this.root}/${file.replace(/^\//, '')}`))
        filesText += `\n### ${file}\n\`\`\`\n${clip(content, 4000)}\n\`\`\`\n`
      } catch {
        filesText += `\n### ${file}\n（主工作区读取失败，可能在worktree）\n`
      }
    }
    const output = this.parseJson(await this.chat(renderPrompt('codeReview', this.customPrompts, {
      requirement: this.requirementJson(item),
      plan: clip(pipe.artifacts.plan, 4000),
      implReport: impl?.summary ?? '',
      fixReport: lastFix?.summary ?? '无',
      files: filesText,
      answers: this.answersText(pipe),
    })))
    pipe.round++
    const issues = asIssues(output.issues)
    pipe.artifacts.reviews.push({ phase: 'code', round: pipe.round, verdict: asText(output.verdict, ''), issues })
    const questions = asQuestions(output.questions)
    if (questions.length > 0) {
      pipe.waiting = { stage: 'code-review', questions }
      this.log(item, `代码评审第${pipe.round}轮提出用户决策`)
      return
    }
    if (output.verdict === 'pass' || pipe.round >= 3) {
      if (output.verdict !== 'pass') this.log(item, '代码评审3轮未全清，遗留问题记入报告')
      pipe.stage = 'verify'
      pipe.round = 0
      pipe.pendingFix = null
      this.log(item, '代码评审通过，进入web验证')
      return
    }
    pipe.pendingFix = issues
    pipe.stage = 'fix-code'
    this.log(item, '代码评审发现问题，等待修复')
  }

  /** Produce the final development report and finish the item. */
  private async runReport(item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const output = this.parseJson(await this.chat(renderPrompt('report', this.customPrompts, {
      requirement: this.requirementJson(item),
      design: clip(pipe.artifacts.design, 5000),
      plan: clip(pipe.artifacts.plan, 4000),
      reviews: JSON.stringify(pipe.artifacts.reviews),
      impls: JSON.stringify(pipe.artifacts.impls),
      fixes: JSON.stringify(pipe.artifacts.fixes),
      verifies: JSON.stringify(pipe.artifacts.verifies),
    })))
    pipe.artifacts.report = asText(output.report, '')
    pipe.files.report = await this.writeFile(`reports/${item.id}-report.md`, pipe.artifacts.report)
    this.release(item)
    item.status = 'done'
    this.log(item, '开发完成，报告已生成')
  }

  /** JSON description of the next pump task, or an idle report. */
  private describeNextTask(): string {
    const state = this.requireState()
    const item = state.items.find((i) => {
      if (i.status !== 'active' || i.pipeline === null) return false
      const pipe = i.pipeline
      return PUMP_STAGES.includes(pipe.stage) && pipe.waiting === null && pipe.error === null
        && pipe.workspace !== null
    })
    if (item === undefined) {
      const waiting = state.items.filter(i => i.status === 'active' && i.pipeline?.waiting !== null).length
      const needs = state.items.filter(i => i.status === 'needs-user').length
      const queued = state.items.filter(i => i.status === 'active' && i.pipeline?.resourceWaiting !== null).length
      return `idle：当前无待泵任务（等待用户决策 ${waiting} 项，待补充需求 ${needs} 项，等待工作区 ${queued} 项）。稍后可再次调用 next。`
    }
    const task = this.pumpTaskFor(item)
    return JSON.stringify(task)
  }

  /** Build the pump-task payload for one pumpable item. */
  private pumpTaskFor(item: DevflowItem): DevflowPumpTask {
    const pipe = this.pipe(item)
    const workspaceHint = pipe.workspace === null
      ? '（尚未分配工作区）'
      : pipe.workspace.kind === 'main'
        ? `主工作区 ${pipe.workspace.path}（小需求：遵循项目规范可直接改 main 或新拉分支）`
        : `worktree ${pipe.workspace.path}（分支 ${pipe.workspace.branch}；若不存在先执行 git worktree add ${pipe.workspace.path} -b ${pipe.workspace.branch} main）`
    switch (pipe.stage) {
      case 'implement':
        return {
          type: 'implement', itemId: item.id, title: item.title, size: item.size,
          design: pipe.files.design, plan: pipe.files.plan, issues: [], acceptance: [],
          workspace: pipe.workspace,
          hint: `先用 read 阅读设计与计划文件（路径见 design/plan 字段），在 ${workspaceHint} 中实施代码改动（遵守项目规范）。`
            + '完成后调用 devflow report：summary=实施摘要, changedFiles=改动文件逗号分隔（相对仓库根）, questions=需用户决策时的JSON数组',
        }
      case 'fix-code':
        return {
          type: 'fix-code', itemId: item.id, title: item.title, size: item.size,
          design: null, plan: pipe.files.plan, issues: pipe.pendingFix ?? [], acceptance: [],
          workspace: pipe.workspace,
          hint: `在 ${workspaceHint} 中按 issues 修复代码后调用 devflow report：summary=修复说明, changedFiles=改动文件逗号分隔`,
        }
      case 'merge': {
        const branch = pipe.workspace?.branch ?? `devflow/${item.id}`
        const worktreePath = pipe.workspace?.path ?? ''
        return {
          type: 'merge', itemId: item.id, title: item.title, size: item.size,
          design: null, plan: null, issues: [], acceptance: [], workspace: pipe.workspace,
          hint: `合并回main流程（在主工作区 ${this.root} 执行，若主工作区有其他任务未提交改动则 report verified=false detail=主工作区被占用）：`
            + `1) git checkout main && git pull(如有远端)；2) git checkout -b ${branch}-merge main；`
            + `3) git merge --no-ff ${branch}，在此集成分支解决所有冲突并跑必要检查；`
            + `4) git checkout main && git merge --no-ff ${branch}-merge；`
            + `5) 清理：git worktree remove ${worktreePath}（如适用）+ git branch -d 功能分支与集成分支。`
            + '完成后 devflow report：verified=true/false, detail=合并与冲突解决记录',
        }
      }
      default:
        return {
          type: 'verify', itemId: item.id, title: item.title, size: item.size,
          design: null, plan: null, issues: [], acceptance: item.refined?.acceptance ?? [],
          workspace: pipe.workspace,
          hint: `在 ${workspaceHint} 中用 playwright-cli 对相关 web 页面做简单自动化验证（打开页面、关键交互、截图）。`
            + '完成后调用 devflow report：verified="true"/"false", detail=验证步骤与结果记录',
        }
    }
  }

  /** Accept one pump-task report and advance the pipeline. */
  private async acceptReport(args: DevflowReportArgs): Promise<{ text: string }> {
    const item = this.requireState().items.find(i => i.id === args.itemId && i.status === 'active')
    if (item === undefined) return { text: `未找到流水线中的需求: ${args.itemId ?? ''}` }
    const pipe = this.pipe(item)
    const changed = (args.changedFiles ?? '').split(',').map(v => v.trim()).filter(v => v !== '')
    let questions: DevflowQuestion[] = []
    if (args.questions !== undefined && args.questions !== '') {
      try {
        questions = JSON.parse(args.questions) as DevflowQuestion[]
      } catch {
        questions = []
      }
    }
    if (pipe.stage === 'implement' || pipe.stage === 'fix-code') {
      const wasImplement = pipe.stage === 'implement'
      const record = { summary: args.summary ?? '', changedFiles: changed }
      if (wasImplement) pipe.artifacts.impls.push(record)
      else pipe.artifacts.fixes.push(record)
      if (questions.length > 0) {
        pipe.waiting = { stage: pipe.stage, questions }
        this.log(item, `${wasImplement ? '实施' : '修复'}中提出用户决策`)
        await this.save()
        return { text: '已记录，等待用户决策后继续' }
      }
      pipe.stage = 'code-review'
      pipe.round = 0
      this.log(item, `${wasImplement ? '实施' : '修复'}报告已接收，进入代码评审`)
    } else if (pipe.stage === 'verify') {
      const ok = args.verified === 'true'
      pipe.artifacts.verifies.push({ verified: ok, detail: args.detail ?? '' })
      if (questions.length > 0) {
        pipe.waiting = { stage: 'verify', questions }
        await this.save()
        return { text: '已记录，等待用户决策后继续' }
      }
      if (ok && pipe.workspace?.kind === 'worktree') {
        pipe.stage = 'merge'
        this.log(item, 'web验证通过，进入合并回main')
      } else if (ok) {
        this.release(item)
        pipe.stage = 'report'
        this.log(item, 'web验证通过（主工作区直接开发，无需合并）')
      } else {
        pipe.stage = 'fix-code'
        pipe.pendingFix = [{ severity: 'high', what: 'web验证未通过', why: '', fix: args.detail || '验证失败，需排查' }]
        this.log(item, 'web验证未通过，回到修复阶段')
      }
    } else if (pipe.stage === 'merge') {
      if (args.verified === 'true') {
        this.release(item)
        pipe.stage = 'report'
        this.log(item, '合并完成（已回并main），生成开发报告')
      } else {
        pipe.error = { stage: 'merge', message: `合并失败: ${clip(args.detail ?? '', 200)}` }
        this.log(item, `合并失败: ${clip(args.detail ?? '', 120)}`)
        await this.save()
        return { text: '已记录合并失败，可在面板重试或人工处理后再泵' }
      }
    } else {
      return { text: `当前阶段 ${pipe.stage} 不接受回填（该阶段由流水线自动处理）` }
    }
    await this.save()
    this.kick()
    return { text: '已回填，流水线继续推进' }
  }

  /** Allocate the main workspace or a worktree slot by item size. */
  private tryAllocate(item: DevflowItem): boolean {
    const state = this.requireState()
    const pipe = this.pipe(item)
    const large = item.size === 'medium' || item.size === 'large'
    if (!large) {
      if (state.mainBusy !== null) {
        pipe.resourceWaiting = 'workspace'
        return false
      }
      state.mainBusy = item.id
      pipe.workspace = { kind: 'main', path: this.root, branch: null }
      pipe.resourceWaiting = null
      this.log(item, '分配主工作区（小需求，当前分支直接开发）')
      return true
    }
    if (state.worktrees.length >= this.maxWorktrees) {
      pipe.resourceWaiting = 'worktree'
      return false
    }
    const path = `${this.root}/.worktrees/devflow-${item.id}`
    const branch = `devflow/${item.id}`
    state.worktrees.push({ id: item.id, path, branch })
    pipe.workspace = { kind: 'worktree', path, branch }
    pipe.resourceWaiting = null
    this.log(item, `分配 worktree ${path}（分支 ${branch}）`)
    return true
  }

  /** Release the main-workspace or worktree slot one item holds. */
  private release(item: DevflowItem): void {
    const state = this.requireState()
    const pipe = this.pipe(item)
    if (pipe.workspace === null) return
    if (pipe.workspace.kind === 'main') {
      if (state.mainBusy === item.id) state.mainBusy = null
    } else {
      state.worktrees = state.worktrees.filter(w => w.id !== item.id)
    }
    pipe.workspace = null
    pipe.resourceWaiting = null
  }

  /** One-shot model call through the current default selection. */
  private async chat(user: string, maxTokens = 8192): Promise<string> {
    const selection = this.modelSelection()
    const options: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
      messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })],
      system: this.customPrompts.system ?? DEFAULT_PROMPTS.system,
      maxTokens,
      temperature: 0.2,
      ...(this.activeController !== null ? { signal: this.activeController.signal } : {}),
    }
    let text = ''
    let finishReason: string | null = null
    for await (const chunk of this.ctx.llm.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') finishReason = chunk.reason.kind
    }
    if (finishReason === 'aborted') throw new Cancelled()
    if (finishReason !== 'stop') throw new Error(`模型输出异常结束: ${finishReason ?? '无finish'}`)
    return text
  }

  /** Extract the first balanced JSON object from model text. */
  private parseJson(text: string): Record<string, unknown> {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error(`模型输出中未找到JSON: ${clip(text, 200)}`)
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  }

  /** Cached repository context block for prompts. */
  private repoCache: string | null = null

  private async repoContext(): Promise<string> {
    if (this.repoCache !== null) return this.repoCache
    let agentsMd = ''
    try {
      agentsMd = await this.ctx.fs.readText(await this.resolve(`${this.root}/AGENTS.md`))
    } catch {
      agentsMd = ''
    }
    const names = async (path: string): Promise<string[]> => {
      try {
        const entries = await this.ctx.fs.listDir(await this.resolve(path))
        return entries.map(entry => entry.name)
      } catch {
        return []
      }
    }
    const [root, docs] = await Promise.all([names(this.root), names(`${this.root}/docs`)])
    this.repoCache = `【项目规范 AGENTS.md（截断）】\n${clip(agentsMd, 6000)}\n【仓库顶层结构】\n${root.join(', ')}\n【docs 目录】\n${docs.join(', ')}`
    return this.repoCache
  }

  /** Current default model selection, or a loud failure. */
  private modelSelection(): ModelSelection {
    const service = this.ctx.get('agentDefaultModel') as { currentSelection(): ModelSelection } | undefined
    if (service === undefined) throw new Error('devflow: agentDefaultModel 服务不可用')
    return service.currentSelection()
  }

  /** Load persisted state and prompts on first touch; concurrent callers share one load. */
  private async ensureLoaded(): Promise<void> {
    // 缓存进行中的 promise 而非布尔标志：并发调用者等待同一次加载，
    // 而不是在加载完成前被“已加载”的假象放行后撞上未就绪的 store
    this.loading ??= this.loadFromDisk().catch((error: unknown) => {
      this.loading = null // 失败后清空缓存，下次调用可重试，避免永久卡死
      throw error
    })
    await this.loading
  }

  /** Read `.devflow/state.json` and `prompts.json` into memory. */
  private async loadFromDisk(): Promise<void> {
    const raw = await this.readFile(['state.json'])
    this.store = raw !== null ? JSON.parse(raw) as DevflowState : this.freshState()
    if (typeof this.store.mainBusy !== 'string') this.store.mainBusy = null
    if (!Array.isArray(this.store.worktrees)) this.store.worktrees = []
    const promptsRaw = await this.readFile(['prompts.json'])
    if (promptsRaw !== null) {
      try {
        this.customPrompts = JSON.parse(promptsRaw) as Record<string, string>
      } catch {
        this.customPrompts = {}
      }
    }
  }

  /** Empty initial state. */
  private freshState(): DevflowState {
    return { seq: 1, items: [], error: null, note: null, mainBusy: null, worktrees: [] }
  }

  private requireState(): DevflowState {
    if (this.store === null) throw new Error('devflow: state is not loaded')
    return this.store
  }

  private findItem(id: string): DevflowItem {
    const item = this.requireState().items.find(i => i.id === id)
    if (item === undefined) throw new Error(`devflow: 需求不存在: ${id}`)
    return item
  }

  private activeItems(): DevflowItem[] {
    return this.requireState().items.filter(i => i.status === 'active')
  }

  /** Highest value-weighted ready item. */
  private pickBest(): DevflowItem & { score: DevflowScore } {
    const ready = this.requireState().items.filter((i): i is DevflowItem & { score: DevflowScore } =>
      i.status === 'ready' && i.score !== null)
    const [head, ...tail] = ready
    if (head === undefined) throw new Error('devflow: no ready item to pick')
    let best: DevflowItem & { score: DevflowScore } = head
    let bestWeight = weight(best.score)
    for (const candidate of tail) {
      const candidateWeight = weight(candidate.score)
      if (candidateWeight > bestWeight) {
        best = candidate
        bestWeight = candidateWeight
      }
    }
    return best
  }

  /** Backfill pipeline fields absent in older persisted state. */
  private pipe(item: DevflowItem): DevflowPipeline {
    if (item.pipeline === null) {
      item.pipeline = {
        stage: 'design', round: 0, waiting: null, error: null, pendingFix: null, answers: [],
        running: false, stageNote: null, workspace: null, resourceWaiting: null,
        artifacts: { design: '', plan: '', reviews: [], impls: [], fixes: [], verifies: [], report: '' },
        files: { design: null, plan: null, report: null },
      }
    }
    return item.pipeline
  }

  /** Append one capped log line. */
  private log(item: DevflowItem, note: string): void {
    const state = this.requireState()
    item.log.push({ n: state.seq++, note })
    if (item.log.length > this.logCap) item.log.splice(0, item.log.length - this.logCap)
  }

  /** Persist the whole state atomically. */
  private async save(): Promise<void> {
    await this.writeFile('state.json', JSON.stringify(this.requireState(), null, 2))
  }

  /** Resolve a path against the fs service. */
  private async resolve(path: string): Promise<FsTarget> {
    return await this.ctx.fs.resolve(path)
  }

  /** Write under `.devflow/` with this deployment's workspace-write policy. */
  private async writeFile(rel: string, content: string): Promise<string> {
    const target = await this.resolve(`${this.dir}/${rel}`)
    await this.ctx.fs.writeText(target, content, undefined, undefined, this.policy)
    return target.displayPath
  }

  /** Read the first existing candidate under `.devflow/`. */
  private async readFile(candidates: readonly string[]): Promise<string | null> {
    for (const rel of candidates) {
      try {
        const content = await this.ctx.fs.readText(await this.resolve(`${this.dir}/${rel}`))
        if (content !== '') return content
      } catch {
        // try next candidate
      }
    }
    return null
  }

  /** Abort the in-flight model call for one item, marking the intent. */
  private abortActive(itemId: string): void {
    if (this.activeController !== null) {
      this.cancelRequestedId = itemId
      this.activeController.abort()
    }
  }

  /** Schedule an immediate tick after a mutation. */
  private kick(): void {
    Promise.resolve().then(() => { void this.tick() }).catch(() => undefined)
  }

  /** The requirement's prompt-facing JSON projection. */
  private requirementJson(item: DevflowItem): string {
    return JSON.stringify({
      id: item.id,
      kind: item.kind,
      title: item.title,
      size: item.size,
      context: item.refined?.context ?? item.raw,
      acceptance: item.refined?.acceptance ?? [],
      scope: item.refined?.scope ?? '',
    }, null, 1)
  }

  /** Earlier user answers as a prompt block. */
  private answersText(pipe: DevflowPipeline): string {
    if (pipe.answers.length === 0) return ''
    return `\n【用户对前期问题的答复（必须遵守）】\n${pipe.answers.map(a => `- ${a.q} → ${a.a}`).join('\n')}`
  }

  /** Wire-safe projection of every item for the panel. */
  private project(): DevflowView {
    const state = this.requireState()
    return {
      busy: this.busy,
      note: state.note ?? null,
      error: state.error ?? null,
      items: state.items.map((item): DevflowItemView => {
        const pipe = item.pipeline
        let note: string | null = null
        if (pipe !== null) {
          if (pipe.running) note = pipe.stageNote ?? '执行中'
          else if (PUMP_STAGES.includes(pipe.stage) && item.status === 'active'
            && pipe.workspace !== null && pipe.waiting === null && pipe.error === null) {
            note = '等待会话泵执行'
          }
        }
        return {
          id: item.id,
          kind: item.kind,
          title: item.title,
          status: item.status,
          size: item.size ?? null,
          score: item.score ?? null,
          running: pipe?.running === true,
          note,
          preview: clip(item.refined?.context ?? item.raw, 120),
          rejectReason: item.rejectReason,
          questions: item.status === 'needs-user'
            ? item.questions ?? null
            : pipe?.waiting?.questions ?? null,
          waitingStage: pipe?.waiting?.stage ?? null,
          stage: pipe?.stage ?? null,
          round: pipe?.round ?? 0,
          error: pipe?.error?.message ?? null,
          workspaceKind: pipe?.workspace?.kind ?? null,
          workspacePath: pipe?.workspace?.path ?? null,
          workspaceBranch: pipe?.workspace?.branch ?? null,
          resourceWaiting: pipe?.resourceWaiting ?? null,
          reportFile: pipe?.files.report ?? null,
          log: item.log.slice(-14),
        }
      }),
    }
  }
}

export default DevflowService
