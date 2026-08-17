/**
 * Automated development pipeline host service: persistent per-project
 * requirement pools with LLM-driven refine → design → plan → review/fix (≤3
 * rounds) stages, per-stage waiting queues for decisions only a human can
 * make, and a session-pumped tool phase (implement / fix-code / verify /
 * merge) whose tasks carry workspace routing — small items on the main
 * workspace, larger ones on dedicated worktrees merged back through an
 * integration branch.
 *
 * The project directory needs no configuration: the dsh workspace root is
 * scanned one level deep for standalone project folders (VCS/package
 * markers), and the panel can add any host folder through the same
 * directory-picking capability the workspace manager uses (native chooser or
 * in-app browse) or by pasting a path. Every project partition then runs in
 * full isolation: its own pool and `.devflow/` state, its own prompts and
 * repo context, its own tick lane (busy/cooldown/abort), and its own
 * main-workspace/worktree budget. Item ids embed the project key, so panel
 * mutations and pump reports route to the owning partition without any
 * extra parameter.
 *
 * The panel reaches this service through generated Remotes
 * (state/submit/answer/cancel/resume/retry/artifact/prompts/prompt-set plus
 * the project-add/remove/scan/pick/list-dir management face); the model
 * reaches it through the `devflow` tool (next/report). All durable state
 * lives under `<root>/.devflow/` as lossless JSON.
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
import { isProjectDir, isScanCandidate, normalizeRoot, projectIdentity, uniqueRoots } from './projects.ts'
import type {
  DevflowAnswerRequest, DevflowArtifactRequest, DevflowDirListing, DevflowItem, DevflowIssue,
  DevflowItemView, DevflowScore, DevflowMutationResult, DevflowPipeline, DevflowPickCapabilityResult,
  DevflowPickNativeResult, DevflowProjectAddRequest, DevflowProjectAddResult, DevflowProjectInfo,
  DevflowProjectOrigin, DevflowProjectRemoveRequest, DevflowProjectScanRequest, DevflowPromptSetRequest,
  DevflowPromptsView, DevflowPumpTask, DevflowQuestion, DevflowReportArgs, DevflowStage, DevflowState,
  DevflowStateRequest, DevflowSubmitRequest, DevflowSubmitResult, DevflowView,
} from './types.ts'

export type * from './types.ts'
export { DEFAULT_PROMPTS, PROMPT_VARS, renderPrompt } from './prompts.ts'
export type { DevflowPromptStage } from './prompts.ts'
export { isProjectDir, isScanCandidate, projectIdentity, uniqueRoots } from './projects.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The automated development pipeline service. */
    devflow: DevflowService
  }
}

/** Deployment configuration for the pipeline. */
export interface Config {
  /** dsh workspace root: project discovery scans here; the shared registry
   * lives under `<root>/.devflow/`. The default project also runs here. */
  readonly root: string
  /** Maximum concurrently active pipelines per project. */
  readonly maxActive: number
  /** Maximum concurrently allocated worktrees per project. */
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
  tickIntervalMs: s.number().step(1).min(500).default(2000),
})

/**
 * One project partition's process-local runtime. Everything the single-root
 * service used to hold globally is held per root here, so projects never
 * serialize each other's ticks, cooldowns, model aborts, or workspace
 * budgets. Durable fields (`store`, `customPrompts`) belong to this root's
 * `.devflow/` only.
 */
interface ProjectRuntime {
  /** Filesystem-safe partition key; also the item-id prefix. */
  readonly key: string
  /** Switcher label (root basename). */
  readonly name: string
  /** Absolute workspace root. */
  readonly root: string
  /** `<root>/.devflow` — this partition's durable directory. */
  readonly dir: string
  /** Workspace-write policy scoped to this root. */
  readonly policy: SandboxExecutionPolicy
  store: DevflowState | null
  loading: Promise<void> | null
  /** Last load failure text (shown when this partition is read); null when healthy. */
  loadError: string | null
  busy: boolean
  cooldown: number
  customPrompts: Record<string, string>
  activeController: AbortController | null
  cancelRequestedId: string | null
  repoCache: string | null
}

/** Listing shape the browse capability returns (structural, wire-safe). */
interface BrowseListingShape {
  path: string
  home: string
  crumbs: readonly { name: string; path: string; hidden: boolean }[]
  entries: readonly { name: string; path: string; hidden: boolean }[]
  truncated: boolean
}

/**
 * Structural slice of `ctx.directoryPicker` (the capability seam the web-GUI
 * workspace manager uses). Optional at runtime: deployments without a
 * picker backend degrade to paste-a-path project adding. The capability is
 * probed dynamically (an unknown backend kind degrades the same way), so
 * the face is intentionally loose and narrowed at each use site.
 */
interface DirectoryPickerFace {
  capability(): unknown
}

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

/** Directory cache lifetime: polls stay cheap, the manage dialog forces. */
const DIRECTORY_TTL_MS = 10_000

/** Upper bound of directory listings one discovery pass may spend. */
const SCAN_BUDGET = 400

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
 * The pipeline service. One process-local timer drives every project
 * partition; each partition's tick owns its state mutations with its own
 * busy flag, and per-call AbortControllers forward panel cancels into
 * in-flight model streams.
 */
export class DevflowService extends TypertRemoteService {
  static inject = ['llm', 'fs', 'tools']

  private readonly root: string
  private readonly rootDir: string
  private readonly rootPolicy: SandboxExecutionPolicy
  private readonly maxActive: number
  private readonly maxWorktrees: number
  private readonly logCap: number
  private readonly runtimes = new Map<string, ProjectRuntime>()
  private addedRoots: string[] = []
  private ignoredRoots: string[] = []
  private registryLoading: Promise<void> | null = null
  private directoryCache: { list: DevflowProjectInfo[]; at: number } | null = null
  private readonly timer: ReturnType<typeof setInterval>

  /**
   * @param ctx - Host context carrying llm/fs/tools.
   * @param config - Deployment configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'devflow')
    this.root = config.root
    this.rootDir = `${config.root}/.devflow`
    this.rootPolicy = { mode: 'workspace-write', workspaceRoot: config.root }
    this.maxActive = config.maxActive
    this.maxWorktrees = config.maxWorktrees
    this.logCap = config.logCap
    this.timer = setInterval(() => {
      for (const project of this.runtimes.values()) void this.tickProject(project)
    }, config.tickIntervalMs)
    ctx.effect(() => () => { clearInterval(this.timer) }, 'devflow.tickTimer')
    ctx.effect(() => this.registerTool(), 'devflow.tool')
  }

  /** Whole-state projection of one project partition (plus the directory). */
  @Remote('state')
  async state(request: DevflowStateRequest): Promise<DevflowView> {
    const directory = await this.syncProjects()
    await this.ensureAllLoaded()
    const project = this.resolveProject(request.project, directory)
    if (project.store === null) {
      throw new Error(`devflow: 项目 ${project.name} 状态加载失败: ${project.loadError ?? '未知错误'}`)
    }
    return this.projectView(project, directory)
  }

  /** Drop one raw requirement or bug into one project's pool. */
  @Remote('submit')
  async submit(request: DevflowSubmitRequest): Promise<DevflowSubmitResult> {
    const directory = await this.syncProjects()
    await this.ensureAllLoaded()
    const project = this.resolveProject(request.project, directory)
    const state = this.requireState(project)
    const text = request.text.trim()
    if (text.length === 0) throw new Error('devflow: requirement text is empty')
    const item: DevflowItem = {
      // The key prefix keeps ids globally unique, so every later itemId call
      // routes back to this partition without an explicit project argument.
      id: `${project.key}-r${state.seq++}`,
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
      log: [{ n: state.seq++, note: `投入需求池（项目 ${project.name}）` }],
    }
    state.items.push(item)
    await this.save(project)
    this.kickProject(project)
    return { ok: true, id: item.id }
  }

  /** Answer waiting-queue or refinement questions. */
  @Remote('answer')
  async answer(request: DevflowAnswerRequest): Promise<DevflowMutationResult> {
    const { p: project, item } = await this.locate(request.itemId)
    if (item.status === 'needs-user') {
      const refined = item.refined ?? { context: item.raw, acceptance: [], scope: '' }
      refined.context += `\n【用户补充】${request.answers.map(a => `${a.q} → ${a.a}`).join('；')}`
      item.refined = refined
      item.status = 'ready'
      item.questions = null
      this.log(project, item, '用户补充完成，重新进入可选池')
    } else if (item.status === 'active') {
      const pipe = this.pipe(item)
      if (pipe.waiting === null
        || (request.stage !== null && pipe.waiting.stage !== request.stage)) {
        throw new Error('devflow: item is not waiting for these answers')
      }
      pipe.answers.push(...request.answers)
      pipe.waiting = null
      this.log(project, item, `用户已决策，继续阶段 ${pipe.stage}`)
    } else {
      throw new Error(`devflow: item status ${item.status} accepts no answers`)
    }
    await this.save(project)
    this.kickProject(project)
    return { ok: true }
  }

  /** Interrupt execution or collapse a waiting entry into a real pause. */
  @Remote('cancel')
  async cancel(request: { itemId: string }): Promise<DevflowMutationResult> {
    const { p: project, item } = await this.locate(request.itemId)
    if (item.status === 'needs-user') {
      item.status = 'paused'
      item.resumeTo = 'needs-user'
      this.log(project, item, '已暂停（问题已收起，继续时重新展示）')
    } else if (item.status === 'refining') {
      this.abortActive(project, item.id)
      item.status = 'paused'
      item.resumeTo = 'raw'
      this.log(project, item, '已中断精炼并暂停')
    } else if (item.status === 'active') {
      this.abortActive(project, item.id)
      const pipe = this.pipe(item)
      const released = pipe.workspace?.kind
      this.release(project, item)
      pipe.waiting = null
      pipe.running = false
      pipe.stageNote = null
      item.status = 'paused'
      item.resumeTo = 'ready'
      this.log(project, item, `已中断并暂停（断点·${pipe.stage}${released !== undefined ? `，已释放${released === 'main' ? '主工作区' : 'worktree'}` : ''}，进度保留）`)
    } else {
      return { ok: false, reason: `当前状态（${item.status}）无需中断` }
    }
    await this.save(project)
    this.kickProject(project)
    return { ok: true }
  }

  /** Resume a paused item back into its pre-interruption lane. */
  @Remote('resume')
  async resume(request: { itemId: string }): Promise<DevflowMutationResult> {
    const { p: project, item } = await this.locate(request.itemId)
    if (item.status !== 'paused') return { ok: false, reason: '该需求不在暂停状态' }
    const to = item.resumeTo ?? 'ready'
    item.status = to === 'needs-user' || to === 'raw' ? to : 'ready'
    item.resumeTo = null
    this.log(project, item, '用户恢复，继续流程')
    await this.save(project)
    this.kickProject(project)
    return { ok: true }
  }

  /** Clear one item's sticky stage error (or refine cooldown). */
  @Remote('retry')
  async retry(request: { itemId: string }): Promise<DevflowMutationResult> {
    const { p: project, item } = await this.locate(request.itemId)
    if (item.pipeline?.error != null) {
      item.pipeline.error = null
      this.log(project, item, '用户触发重试')
      await this.save(project)
    }
    if (item.status === 'refining' || item.status === 'raw') {
      this.requireState(project).error = null
      project.cooldown = 0
    }
    this.kickProject(project)
    return { ok: true }
  }

  /** Read one artifact's (clipped) text for the panel viewer. */
  @Remote('artifact')
  async artifact(request: DevflowArtifactRequest): Promise<string> {
    const { item } = await this.locate(request.itemId)
    if (item.pipeline === null) throw new Error('devflow: item has no artifacts')
    const artifacts = item.pipeline.artifacts
    switch (request.name) {
      case 'design': return clip(artifacts.design, 8000)
      case 'plan': return clip(artifacts.plan, 8000)
      case 'report': return clip(artifacts.report, 8000)
      case 'reviews': return clip(JSON.stringify(artifacts.reviews, null, 1), 8000)
    }
  }

  /** Prompt-template directory of one project: defaults plus overrides. */
  @Remote('prompts')
  async prompts(request: DevflowStateRequest): Promise<DevflowPromptsView> {
    const directory = await this.syncProjects()
    await this.ensureAllLoaded()
    const project = this.resolveProject(request.project, directory)
    return { custom: project.customPrompts, defaults: DEFAULT_PROMPTS, vars: PROMPT_VARS }
  }

  /** Set (or clear with null) one stage's custom template for one project. */
  @Remote('prompt-set')
  async promptSet(request: DevflowPromptSetRequest): Promise<DevflowMutationResult> {
    const directory = await this.syncProjects()
    await this.ensureAllLoaded()
    const project = this.resolveProject(request.project, directory)
    if (!(request.stage in DEFAULT_PROMPTS)) throw new Error(`devflow: unknown prompt stage ${request.stage}`)
    if (request.template === null || request.template.trim() === '') {
      project.customPrompts = Object.fromEntries(
        Object.entries(project.customPrompts).filter(([key]) => key !== request.stage),
      )
    } else {
      project.customPrompts[request.stage] = request.template
    }
    await this.writeFile(project, 'prompts.json', JSON.stringify(project.customPrompts, null, 2))
    return { ok: true }
  }

  /** Add one project folder manually (also un-ignores the path). */
  @Remote('project-add')
  async projectAdd(request: DevflowProjectAddRequest): Promise<DevflowProjectAddResult> {
    const path = request.path.trim()
    if (path === '') return { ok: false, reason: '路径为空', key: null }
    try {
      await this.ctx.fs.listDir(await this.resolve(path))
    } catch {
      return { ok: false, reason: '目录不可读或不存在', key: null }
    }
    const id = normalizeRoot(path)
    if (!this.addedRoots.some(p => normalizeRoot(p) === id)) this.addedRoots.push(path)
    this.ignoredRoots = this.ignoredRoots.filter(p => normalizeRoot(p) !== id)
    await this.saveRegistry()
    const runtime = this.ensureRuntime(path)
    await this.syncProjects(true)
    return { ok: true, key: runtime.key }
  }

  /** Hide one project from the directory (its durable state is kept). */
  @Remote('project-remove')
  async projectRemove(request: DevflowProjectRemoveRequest): Promise<DevflowMutationResult> {
    const directory = await this.syncProjects()
    const info = directory.find(p => p.key === request.key)
    if (info === undefined) return { ok: false, reason: '未知项目' }
    const id = normalizeRoot(info.root)
    this.addedRoots = this.addedRoots.filter(p => normalizeRoot(p) !== id)
    if (!this.ignoredRoots.some(p => normalizeRoot(p) === id)) this.ignoredRoots.push(info.root)
    await this.saveRegistry()
    let remaining = await this.syncProjects(true)
    if (remaining.length === 0) {
      // Never leave the panel projectless: keep the workspace root visible.
      const rootId = normalizeRoot(this.root)
      this.ignoredRoots = this.ignoredRoots.filter(p => normalizeRoot(p) !== rootId)
      await this.saveRegistry()
      remaining = await this.syncProjects(true)
    }
    return remaining.length === 0 ? { ok: false, reason: '至少保留一个项目' } : { ok: true }
  }

  /** Force a workspace rescan (the manage dialog calls this on open). */
  @Remote('project-scan')
  async projectScan(_request: DevflowProjectScanRequest): Promise<DevflowMutationResult> {
    await this.syncProjects(true)
    return { ok: true }
  }

  /** Which folder-picking interaction the host offers for manual adds. */
  @Remote('project-pick-capability')
  async projectPickCapability(): Promise<DevflowPickCapabilityResult> {
    const picker = this.picker()
    if (picker === undefined) return { kind: 'none' }
    try {
      const kind = (picker.capability() as { kind?: string }).kind
      return kind === 'native' || kind === 'browse' ? { kind } : { kind: 'none' }
    } catch {
      return { kind: 'none' }
    }
  }

  /** One native OS chooser round trip (null when the operator cancels). */
  @Remote('project-pick-native')
  async projectPickNative(): Promise<DevflowPickNativeResult> {
    const picker = this.picker()
    if (picker === undefined) throw new Error('devflow: 目录选择服务不可用')
    const capability = picker.capability() as {
      kind?: string
      pick?: (signal: AbortSignal) => Promise<string | null>
    }
    if (capability.kind !== 'native' || typeof capability.pick !== 'function') {
      throw new Error('devflow: 当前后端不支持系统目录选择')
    }
    const path = await capability.pick(new AbortController().signal)
    return { path }
  }

  /** One directory level for the in-app browse flow. */
  @Remote('project-list-dir')
  async projectListDir(request: { path: string | null }): Promise<DevflowDirListing> {
    const picker = this.picker()
    if (picker === undefined) throw new Error('devflow: 目录浏览服务不可用')
    const capability = picker.capability() as {
      kind?: string
      list?: (path?: string, signal?: AbortSignal) => Promise<BrowseListingShape>
    }
    if (capability.kind !== 'browse' || typeof capability.list !== 'function') {
      throw new Error('devflow: 当前后端不支持目录浏览')
    }
    const listing = await capability.list(request.path ?? undefined)
    return {
      path: listing.path,
      home: listing.home,
      truncated: listing.truncated,
      crumbs: listing.crumbs.map(c => ({ name: c.name, path: c.path, hidden: c.hidden })),
      entries: listing.entries.map(c => ({ name: c.name, path: c.path, hidden: c.hidden })),
    }
  }

  /** Register the session-facing task pump tool. */
  private registerTool(): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'devflow',
      description: '自动开发流水线任务泵：LLM文本阶段（需求精炼/设计/计划/评审/报告）由插件后台自动推进，'
        + '无需本工具；本工具只服务需要工具能力的阶段（implement/fix-code/verify/merge，'
        + '任务带工作区路由：小需求主工作区、中大需求worktree，merge为集成分支合并回main）。'
        + '需求池按项目隔离（面板自动发现/手动添加项目），任务携带所属项目的 project/projectRoot；'
        + 'itemId 前缀即项目路由。action=next 获取下一个待执行任务；action=report 回填任务结果推进流水线。',
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
        if (args.action === 'next') return { text: this.describeNextTask() }
        return await this.acceptReport(args)
      },
    }))
  }

  /** The optional directory-picker capability seam, when composed. */
  private picker(): DirectoryPickerFace | undefined {
    return this.ctx.get('directoryPicker') as DirectoryPickerFace | undefined
  }

  /** Load the shared project registry (`<root>/.devflow/projects.json`). */
  private async ensureRegistry(): Promise<void> {
    this.registryLoading ??= (async () => {
      try {
        const raw = await this.readRootFile('projects.json')
        if (raw !== null) {
          const parsed = JSON.parse(raw) as { added?: unknown; ignored?: unknown }
          this.addedRoots = Array.isArray(parsed.added)
            ? parsed.added.filter((v): v is string => typeof v === 'string')
            : []
          this.ignoredRoots = Array.isArray(parsed.ignored)
            ? parsed.ignored.filter((v): v is string => typeof v === 'string')
            : []
        }
      } catch {
        // unreadable/corrupt registry: start fresh; the next save rewrites it
      }
    })()
    await this.registryLoading
  }

  /** Persist the shared registry. */
  private async saveRegistry(): Promise<void> {
    const target = await this.resolve(`${this.rootDir}/projects.json`)
    await this.ctx.fs.writeText(
      target, JSON.stringify({ added: this.addedRoots, ignored: this.ignoredRoots }, null, 2),
      undefined, undefined, this.rootPolicy,
    )
  }

  /** Read one file under the workspace-root `.devflow/`. */
  private async readRootFile(rel: string): Promise<string | null> {
    try {
      const content = await this.ctx.fs.readText(await this.resolve(`${this.rootDir}/${rel}`))
      return content === '' ? null : content
    } catch {
      return null
    }
  }

  /** Get or create the runtime of one project path. */
  private ensureRuntime(path: string): ProjectRuntime {
    const { key, name } = projectIdentity(path)
    const existing = this.runtimes.get(key)
    if (existing !== undefined) return existing
    const runtime: ProjectRuntime = {
      key,
      name,
      root: path,
      dir: `${path}/.devflow`,
      policy: { mode: 'workspace-write', workspaceRoot: path },
      store: null,
      loading: null,
      loadError: null,
      busy: false,
      cooldown: 0,
      customPrompts: {},
      activeController: null,
      cancelRequestedId: null,
      repoCache: null,
    }
    this.runtimes.set(key, runtime)
    return runtime
  }

  /**
   * Scan the workspace for standalone project folders. Semantics: a root
   * that is itself a project (monorepo style) is one single partition —
   * nothing inside it is scanned; otherwise depth-1 children are probed and
   * project groups get one more level (`~/projects/group/repo` layouts).
   * A probe budget bounds pathological trees.
   */
  private async discoverRoots(): Promise<{ scanned: string[]; rootIsProject: boolean }> {
    let budget = SCAN_BUDGET
    const spend = (): boolean => {
      if (budget <= 0) return false
      budget--
      return true
    }
    let rootEntries: readonly {
      name: string
      type: 'file' | 'directory' | 'other'
      target?: unknown
    }[] = []
    try {
      rootEntries = await this.ctx.fs.listDir(await this.resolve(this.root))
    } catch {
      return { scanned: [], rootIsProject: false }
    }
    const rootIsProject = isProjectDir(rootEntries.map(e => e.name))
    if (rootIsProject) return { scanned: [], rootIsProject: true }
    const scanned: string[] = []
    const listNames = async (target: unknown): Promise<string[] | null> => {
      if (!spend()) return null
      try {
        const children = await this.ctx.fs.listDir(target as FsTarget)
        return children.map(c => c.name)
      } catch {
        return null
      }
    }
    for (const entry of rootEntries) {
      if (!isScanCandidate(entry.name, entry.type)) continue
      const childNames = await listNames(entry.target)
      if (childNames === null) continue
      if (isProjectDir(childNames)) {
        scanned.push(`${this.root}/${entry.name}`)
        continue
      }
      // A non-project child may be a project group folder: probe one level
      // deeper so `~/projects/group/repo` layouts surface.
      let childEntries: readonly {
        name: string
        type: 'file' | 'directory' | 'other'
        target?: unknown
      }[] = []
      try {
        childEntries = await this.ctx.fs.listDir(entry.target as FsTarget)
      } catch {
        continue
      }
      for (const grandchild of childEntries) {
        if (!isScanCandidate(grandchild.name, grandchild.type)) continue
        const names = await listNames(grandchild.target)
        if (names !== null && isProjectDir(names)) scanned.push(`${this.root}/${entry.name}/${grandchild.name}`)
      }
    }
    scanned.sort()
    return { scanned, rootIsProject }
  }

  /**
   * Build (and cache) the visible project directory: workspace root (when it
   * is itself a project, or as the last-resort default), auto-scanned
   * folders, then manually added ones — hidden roots filtered out, one
   * runtime ensured per visible project.
   */
  private async syncProjects(force = false): Promise<DevflowProjectInfo[]> {
    await this.ensureRegistry()
    if (!force && this.directoryCache !== null && Date.now() - this.directoryCache.at < DIRECTORY_TTL_MS) {
      return this.directoryCache.list
    }
    const { scanned, rootIsProject } = await this.discoverRoots()
    const manual = [...this.addedRoots].sort()
    const rootId = normalizeRoot(this.root)
    const ignored = new Set(this.ignoredRoots.map(normalizeRoot))
    const ordered: string[] = []
    if (rootIsProject || (scanned.length === 0 && manual.length === 0)) ordered.push(this.root)
    ordered.push(...scanned, ...manual)
    const seen = new Set<string>()
    const list: DevflowProjectInfo[] = []
    for (const path of ordered) {
      const id = normalizeRoot(path)
      if (id === '' || seen.has(id) || ignored.has(id)) continue
      seen.add(id)
      const runtime = this.ensureRuntime(path)
      const origin: DevflowProjectOrigin = id === rootId
        ? 'workspace'
        : this.addedRoots.some(p => normalizeRoot(p) === id) ? 'manual' : 'scan'
      list.push({ key: runtime.key, name: runtime.name, root: runtime.root, origin })
    }
    this.directoryCache = { list, at: Date.now() }
    return list
  }

  /**
   * Resolve a project key against the directory; an unknown or hidden key
   * falls back to the default (first) project so a stale client selection
   * after removal keeps the panel alive instead of erroring.
   */
  private resolveProject(key: string | null, directory: readonly DevflowProjectInfo[]): ProjectRuntime {
    if (key !== null && key !== '') {
      const hit = directory.find(p => p.key === key)
      if (hit !== undefined) {
        const runtime = this.runtimes.get(hit.key)
        if (runtime !== undefined) return runtime
      }
    }
    const first = directory[0]
    if (first === undefined) throw new Error('devflow: 项目目录为空')
    return this.runtimes.get(first.key) as ProjectRuntime
  }

  /** One project-scoped state-machine beat: refine, admit, allocate, advance. */
  private async tickProject(project: ProjectRuntime): Promise<void> {
    if (project.busy) return
    // 互斥须覆盖 ensureLoaded 阶段：否则上一跳仍在加载 store 时，
    // 下一跳已越过 busy 检查闯入状态机主体
    project.busy = true
    try {
      await this.ensureLoaded(project)
      if (project.cooldown > 0) {
        project.cooldown--
        return
      }
      const state = this.requireState(project)
      if (state.items.some(i => i.status === 'raw' || i.status === 'refining')) {
        await this.withAbort(project, async () => this.runRefine(project), (error) => {
          if (project.cancelRequestedId !== null) {
            for (const item of state.items) if (item.status === 'refining') item.status = 'raw'
            project.cancelRequestedId = null
            state.error = null
            project.cooldown = 0
          } else {
            state.error = `精炼失败: ${error.message}`
            project.cooldown = 30
          }
          state.note = null
        })
        await this.save(project)
        return
      }
      while (this.activeItems(project).length < this.maxActive
        && state.items.some(i => i.status === 'ready' && i.score !== null)) {
        const best = this.pickBest(project)
        best.status = 'active'
        this.log(project, best, `被选中进入流水线（价值${best.score.value}/完整${best.score.completeness}）`)
        await this.save(project)
      }
      let allocChanged = false
      for (const item of this.activeItems(project)) {
        const pipe = this.pipe(item)
        if (PUMP_STAGES.includes(pipe.stage) && pipe.workspace === null && pipe.resourceWaiting === null) {
          if (this.tryAllocate(project, item)) allocChanged = true
        }
      }
      if (allocChanged) await this.save(project)
      const target = this.activeItems(project).find((item) => {
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
      await this.save(project)
      try {
        await this.runAutoStage(project, target)
      } finally {
        project.activeController = null
        pipe.running = false
        pipe.stageNote = null
      }
      await this.save(project)
    } catch (error) {
      await this.recordTickFailure(project, error)
    } finally {
      project.busy = false
    }
  }

  /** Run an abortable block, routing cancellation vs failure to the handler. */
  private async withAbort(
    project: ProjectRuntime,
    run: () => Promise<void>,
    onFailure: (error: Error) => void,
  ): Promise<void> {
    project.activeController = new AbortController()
    try {
      await run()
    } catch (error) {
      onFailure(error instanceof Error ? error : new Error(describeUnknown(error)))
    } finally {
      project.activeController = null
    }
  }

  /** Persist a stage failure onto the running item unless it was intentional. */
  private async recordTickFailure(project: ProjectRuntime, error: unknown): Promise<void> {
    // state 尚未加载时无法落盘任何失败信息，只记日志；
    // 这里再抛错会把可恢复的 tick 失败放大成进程级 fatal
    if (project.store === null) {
      this.ctx.logger.error('devflow: tick failed before state loaded (%s): %s', project.name, describeUnknown(error))
      return
    }
    const running = project.store.items.find(i => i.status === 'active' && i.pipeline?.running === true)
    const intentional = running !== undefined && project.cancelRequestedId === running.id
    project.cancelRequestedId = null
    try {
      if (running !== undefined && !intentional) {
        const pipe = this.pipe(running)
        pipe.error = { stage: pipe.stage, message: describeUnknown(error) }
        this.log(project, running, `阶段${pipe.stage}出错: ${pipe.error.message}`)
      }
      await this.save(project)
    } catch (nested) {
      this.ctx.logger.error('devflow: failed to record tick failure: %s', describeUnknown(nested))
    }
  }

  /** Dispatch one item's current auto stage. */
  private async runAutoStage(project: ProjectRuntime, item: DevflowItem): Promise<void> {
    const stage = this.pipe(item).stage
    switch (stage) {
      case 'design': return this.runDesign(project, item)
      case 'plan': return this.runPlan(project, item)
      case 'review-dp': return this.runReviewDp(project, item)
      case 'code-review': return this.runReviewCode(project, item)
      case 'report': return this.runReport(project, item)
      default: throw new Error(`devflow: stage ${stage} is not automatic`)
    }
  }

  /** Batch-refine every raw item of one project: enrich, score, size, triage. */
  private async runRefine(project: ProjectRuntime): Promise<void> {
    const state = this.requireState(project)
    const batch = state.items.filter(i => i.status === 'raw' || i.status === 'refining')
    if (batch.length === 0) return
    for (const item of batch) item.status = 'refining'
    state.error = null
    state.note = `正在精炼 ${batch.length} 条需求（调用模型）`
    await this.save(project)
    const user = renderPrompt('refine', project.customPrompts, {
      repo: await this.repoContext(project),
      batch: JSON.stringify(batch.map(i => ({ id: i.id, kind: i.kind, raw: i.raw })), null, 1),
    })
    const output = this.parseJson(await this.chat(project, user))
    const byId = new Map<string, Record<string, unknown>>()
    for (const row of (output.items as Record<string, unknown>[] | undefined) ?? []) {
      byId.set(String(row.id), row)
    }
    for (const item of batch) {
      const row = byId.get(item.id)
      if (row === undefined) {
        item.status = 'raw'
        this.log(project, item, '精炼未返回，退回待精炼')
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
        this.log(project, item, `判定搁置: ${item.rejectReason}`)
      } else if (row.incomplete === true && questions.length > 0) {
        item.status = 'needs-user'
        item.questions = questions
        this.log(project, item, '待用户补充意图')
      } else {
        item.status = 'ready'
        this.log(project, item, `精炼完成（规模${item.size === 'small' ? '小' : item.size === 'medium' ? '中' : '大'}），进入可选池`)
      }
    }
    state.note = null
  }

  /** Produce the design document. */
  private async runDesign(project: ProjectRuntime, item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const output = this.parseJson(await this.chat(project, renderPrompt('design', project.customPrompts, {
      repo: await this.repoContext(project),
      requirement: this.requirementJson(item),
      answers: this.answersText(pipe),
    })))
    pipe.artifacts.design = asText(output.design, '')
    pipe.files.design = await this.writeFile(project, `artifacts/${item.id}-design.md`, pipe.artifacts.design)
    const questions = asQuestions(output.questions)
    if (questions.length > 0) {
      pipe.waiting = { stage: 'design', questions }
      this.log(project, item, '设计产出，有必须用户决策项')
    } else {
      pipe.stage = 'plan'
      this.log(project, item, '设计完成')
    }
  }

  /** Produce the implementation plan. */
  private async runPlan(project: ProjectRuntime, item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const output = this.parseJson(await this.chat(project, renderPrompt('plan', project.customPrompts, {
      requirement: this.requirementJson(item),
      design: pipe.artifacts.design,
      answers: this.answersText(pipe),
    })))
    pipe.artifacts.plan = asText(output.plan, '')
    pipe.files.plan = await this.writeFile(project, `artifacts/${item.id}-plan.md`, pipe.artifacts.plan)
    const questions = asQuestions(output.questions)
    if (questions.length > 0) {
      pipe.waiting = { stage: 'plan', questions }
      this.log(project, item, '计划产出，有必须用户决策项')
    } else {
      pipe.stage = 'review-dp'
      pipe.round = 0
      this.log(project, item, '计划完成，进入设计/计划评审')
    }
  }

  /** Review design+plan; pass, escalate to the user, or revise and re-review. */
  private async runReviewDp(project: ProjectRuntime, item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const output = this.parseJson(await this.chat(project, renderPrompt('reviewDp', project.customPrompts, {
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
      this.log(project, item, `评审第${pipe.round}轮提出用户决策`)
      return
    }
    if (output.verdict === 'pass' || pipe.round >= 3) {
      if (output.verdict !== 'pass') this.log(project, item, '评审3轮未全清，遗留问题记入报告')
      pipe.stage = 'implement'
      pipe.round = 0
      pipe.pendingFix = null
      this.log(project, item, `设计/计划评审通过，进入实施（规模${item.size === 'medium' || item.size === 'large' ? '中大·worktree' : '小·主工作区'}）`)
      return
    }
    await this.fixDesignAndPlan(project, item, issues)
  }

  /** Revise design and plan to resolve review issues. */
  private async fixDesignAndPlan(
    project: ProjectRuntime,
    item: DevflowItem,
    issues: DevflowPipeline['pendingFix'],
  ): Promise<void> {
    const pipe = this.pipe(item)
    const issuesJson = JSON.stringify(issues, null, 1)
    const designOut = this.parseJson(await this.chat(project, renderPrompt('fixDesign', project.customPrompts, {
      design: pipe.artifacts.design,
      issues: issuesJson,
    })))
    if (typeof designOut.doc === 'string' && designOut.doc !== '') {
      pipe.artifacts.design = designOut.doc
      pipe.files.design = await this.writeFile(project, `artifacts/${item.id}-design.md`, designOut.doc)
    }
    const planOut = this.parseJson(await this.chat(project, renderPrompt('fixPlan', project.customPrompts, {
      design: clip(pipe.artifacts.design, 6000),
      plan: pipe.artifacts.plan,
      issues: issuesJson,
    })))
    if (typeof planOut.doc === 'string' && planOut.doc !== '') {
      pipe.artifacts.plan = planOut.doc
      pipe.files.plan = await this.writeFile(project, `artifacts/${item.id}-plan.md`, planOut.doc)
    }
    this.log(project, item, '按评审意见修订了设计与计划')
  }

  /** Review the implemented diff set; pass, escalate, or queue fixes. */
  private async runReviewCode(project: ProjectRuntime, item: DevflowItem): Promise<void> {
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
        const content = await this.ctx.fs.readText(await this.resolve(`${project.root}/${file.replace(/^\//, '')}`))
        filesText += `\n### ${file}\n\`\`\`\n${clip(content, 4000)}\n\`\`\`\n`
      } catch {
        filesText += `\n### ${file}\n（主工作区读取失败，可能在worktree）\n`
      }
    }
    const output = this.parseJson(await this.chat(project, renderPrompt('codeReview', project.customPrompts, {
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
      this.log(project, item, `代码评审第${pipe.round}轮提出用户决策`)
      return
    }
    if (output.verdict === 'pass' || pipe.round >= 3) {
      if (output.verdict !== 'pass') this.log(project, item, '代码评审3轮未全清，遗留问题记入报告')
      pipe.stage = 'verify'
      pipe.round = 0
      pipe.pendingFix = null
      this.log(project, item, '代码评审通过，进入web验证')
      return
    }
    pipe.pendingFix = issues
    pipe.stage = 'fix-code'
    this.log(project, item, '代码评审发现问题，等待修复')
  }

  /** Produce the final development report and finish the item. */
  private async runReport(project: ProjectRuntime, item: DevflowItem): Promise<void> {
    const pipe = this.pipe(item)
    const output = this.parseJson(await this.chat(project, renderPrompt('report', project.customPrompts, {
      requirement: this.requirementJson(item),
      design: clip(pipe.artifacts.design, 5000),
      plan: clip(pipe.artifacts.plan, 4000),
      reviews: JSON.stringify(pipe.artifacts.reviews),
      impls: JSON.stringify(pipe.artifacts.impls),
      fixes: JSON.stringify(pipe.artifacts.fixes),
      verifies: JSON.stringify(pipe.artifacts.verifies),
    })))
    pipe.artifacts.report = asText(output.report, '')
    pipe.files.report = await this.writeFile(project, `reports/${item.id}-report.md`, pipe.artifacts.report)
    this.release(project, item)
    item.status = 'done'
    this.log(project, item, '开发完成，报告已生成')
  }

  /** JSON description of the next pump task across projects, or an idle report. */
  private describeNextTask(): string {
    const next = this.nextPumpable()
    if (next === undefined) {
      let waiting = 0
      let needs = 0
      let queued = 0
      for (const project of this.runtimes.values()) {
        if (project.store === null) continue
        for (const item of project.store.items) {
          if (item.status === 'needs-user') needs++
          if (item.status !== 'active' || item.pipeline === null) continue
          if (item.pipeline.waiting !== null) waiting++
          if (item.pipeline.resourceWaiting !== null) queued++
        }
      }
      return `idle：当前无待泵任务（等待用户决策 ${waiting} 项，待补充需求 ${needs} 项，等待工作区 ${queued} 项）。稍后可再次调用 next。`
    }
    return JSON.stringify(this.pumpTaskFor(next.p, next.item))
  }

  /** First pumpable item across projects, in directory order. */
  private nextPumpable(): { p: ProjectRuntime; item: DevflowItem } | undefined {
    const order = this.directoryCache?.list
      ?? [...this.runtimes.values()].map(p => ({ key: p.key }))
    for (const info of order) {
      const project = this.runtimes.get(info.key)
      if (project === undefined || project.store === null) continue
      const found = project.store.items.find((item) => {
        if (item.status !== 'active' || item.pipeline === null) return false
        const pipe = item.pipeline
        return PUMP_STAGES.includes(pipe.stage) && pipe.waiting === null && pipe.error === null
          && pipe.workspace !== null
      })
      if (found !== undefined) return { p: project, item: found }
    }
    return undefined
  }

  /** Build the pump-task payload for one pumpable item. */
  private pumpTaskFor(project: ProjectRuntime, item: DevflowItem): DevflowPumpTask {
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
          project: project.key, projectRoot: project.root,
          design: pipe.files.design, plan: pipe.files.plan, issues: [], acceptance: [],
          workspace: pipe.workspace,
          hint: `项目 ${project.name}（根 ${project.root}）。先用 read 阅读设计与计划文件（路径见 design/plan 字段），在 ${workspaceHint} 中实施代码改动（遵守项目规范）。`
            + '完成后调用 devflow report：summary=实施摘要, changedFiles=改动文件逗号分隔（相对仓库根）, questions=需用户决策时的JSON数组',
        }
      case 'fix-code':
        return {
          type: 'fix-code', itemId: item.id, title: item.title, size: item.size,
          project: project.key, projectRoot: project.root,
          design: null, plan: pipe.files.plan, issues: pipe.pendingFix ?? [], acceptance: [],
          workspace: pipe.workspace,
          hint: `项目 ${project.name}（根 ${project.root}）。在 ${workspaceHint} 中按 issues 修复代码后调用 devflow report：summary=修复说明, changedFiles=改动文件逗号分隔`,
        }
      case 'merge': {
        const branch = pipe.workspace?.branch ?? `devflow/${item.id}`
        const worktreePath = pipe.workspace?.path ?? ''
        return {
          type: 'merge', itemId: item.id, title: item.title, size: item.size,
          project: project.key, projectRoot: project.root,
          design: null, plan: null, issues: [], acceptance: [], workspace: pipe.workspace,
          hint: `项目 ${project.name}。合并回main流程（在主工作区 ${project.root} 执行，若主工作区有其他任务未提交改动则 report verified=false detail=主工作区被占用）：`
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
          project: project.key, projectRoot: project.root,
          design: null, plan: null, issues: [], acceptance: item.refined?.acceptance ?? [],
          workspace: pipe.workspace,
          hint: `项目 ${project.name}（根 ${project.root}）。在 ${workspaceHint} 中用 playwright-cli 对相关 web 页面做简单自动化验证（打开页面、关键交互、截图）。`
            + '完成后调用 devflow report：verified="true"/"false", detail=验证步骤与结果记录',
        }
    }
  }

  /** Accept one pump-task report and advance the pipeline. */
  private async acceptReport(args: DevflowReportArgs): Promise<{ text: string }> {
    const located = await this.locateActive(args.itemId)
    if (located === undefined) return { text: `未找到流水线中的需求: ${args.itemId ?? ''}` }
    const { p: project, item } = located
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
        this.log(project, item, `${wasImplement ? '实施' : '修复'}中提出用户决策`)
        await this.save(project)
        return { text: '已记录，等待用户决策后继续' }
      }
      pipe.stage = 'code-review'
      pipe.round = 0
      this.log(project, item, `${wasImplement ? '实施' : '修复'}报告已接收，进入代码评审`)
    } else if (pipe.stage === 'verify') {
      const ok = args.verified === 'true'
      pipe.artifacts.verifies.push({ verified: ok, detail: args.detail ?? '' })
      if (questions.length > 0) {
        pipe.waiting = { stage: 'verify', questions }
        await this.save(project)
        return { text: '已记录，等待用户决策后继续' }
      }
      if (ok && pipe.workspace?.kind === 'worktree') {
        pipe.stage = 'merge'
        this.log(project, item, 'web验证通过，进入合并回main')
      } else if (ok) {
        this.release(project, item)
        pipe.stage = 'report'
        this.log(project, item, 'web验证通过（主工作区直接开发，无需合并）')
      } else {
        pipe.stage = 'fix-code'
        pipe.pendingFix = [{ severity: 'high', what: 'web验证未通过', why: '', fix: args.detail || '验证失败，需排查' }]
        this.log(project, item, 'web验证未通过，回到修复阶段')
      }
    } else if (pipe.stage === 'merge') {
      if (args.verified === 'true') {
        this.release(project, item)
        pipe.stage = 'report'
        this.log(project, item, '合并完成（已回并main），生成开发报告')
      } else {
        pipe.error = { stage: 'merge', message: `合并失败: ${clip(args.detail ?? '', 200)}` }
        this.log(project, item, `合并失败: ${clip(args.detail ?? '', 120)}`)
        await this.save(project)
        return { text: '已记录合并失败，可在面板重试或人工处理后再泵' }
      }
    } else {
      return { text: `当前阶段 ${pipe.stage} 不接受回填（该阶段由流水线自动处理）` }
    }
    await this.save(project)
    this.kickProject(project)
    return { text: '已回填，流水线继续推进' }
  }

  /** Allocate the main workspace or a worktree slot by item size. */
  private tryAllocate(project: ProjectRuntime, item: DevflowItem): boolean {
    const state = this.requireState(project)
    const pipe = this.pipe(item)
    const large = item.size === 'medium' || item.size === 'large'
    if (!large) {
      if (state.mainBusy !== null) {
        pipe.resourceWaiting = 'workspace'
        return false
      }
      state.mainBusy = item.id
      pipe.workspace = { kind: 'main', path: project.root, branch: null }
      pipe.resourceWaiting = null
      this.log(project, item, '分配主工作区（小需求，当前分支直接开发）')
      return true
    }
    if (state.worktrees.length >= this.maxWorktrees) {
      pipe.resourceWaiting = 'worktree'
      return false
    }
    const path = `${project.root}/.worktrees/devflow-${item.id}`
    const branch = `devflow/${item.id}`
    state.worktrees.push({ id: item.id, path, branch })
    pipe.workspace = { kind: 'worktree', path, branch }
    pipe.resourceWaiting = null
    this.log(project, item, `分配 worktree ${path}（分支 ${branch}）`)
    return true
  }

  /** Release the main-workspace or worktree slot one item holds. */
  private release(project: ProjectRuntime, item: DevflowItem): void {
    const state = this.requireState(project)
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
  private async chat(project: ProjectRuntime, user: string, maxTokens = 8192): Promise<string> {
    const selection = this.modelSelection()
    const options: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
      messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })],
      system: project.customPrompts.system ?? DEFAULT_PROMPTS.system,
      maxTokens,
      temperature: 0.2,
      ...(project.activeController !== null ? { signal: project.activeController.signal } : {}),
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

  /** Cached repository context block for prompts (per project root). */
  private async repoContext(project: ProjectRuntime): Promise<string> {
    if (project.repoCache !== null) return project.repoCache
    let agentsMd = ''
    try {
      agentsMd = await this.ctx.fs.readText(await this.resolve(`${project.root}/AGENTS.md`))
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
    const [root, docs] = await Promise.all([names(project.root), names(`${project.root}/docs`)])
    project.repoCache = `【项目规范 AGENTS.md（截断）】\n${clip(agentsMd, 6000)}\n【仓库顶层结构】\n${root.join(', ')}\n【docs 目录】\n${docs.join(', ')}`
    return project.repoCache
  }

  /** Current default model selection, or a loud failure. */
  private modelSelection(): ModelSelection {
    const service = this.ctx.get('agentDefaultModel') as { currentSelection(): ModelSelection } | undefined
    if (service === undefined) throw new Error('devflow: agentDefaultModel 服务不可用')
    return service.currentSelection()
  }

  /** Locate one item across every project; throws when absent or ambiguous. */
  private async locate(id: string): Promise<{ p: ProjectRuntime; item: DevflowItem }> {
    const matches: { p: ProjectRuntime; item: DevflowItem }[] = []
    const loadErrors: string[] = []
    for (const project of this.runtimes.values()) {
      try {
        await this.ensureLoaded(project)
      } catch (error) {
        loadErrors.push(describeUnknown(error))
      }
      if (project.store === null) continue
      const item = project.store.items.find(i => i.id === id)
      if (item !== undefined) matches.push({ p: project, item })
    }
    if (matches.length > 1) throw new Error(`devflow: 需求 id 跨项目不唯一: ${id}`)
    if (matches.length === 1) return matches[0]
    if (loadErrors.length > 0) throw new Error(`devflow: 项目状态加载失败: ${loadErrors[0]}`)
    throw new Error(`devflow: 需求不存在: ${id}`)
  }

  /** Locate one ACTIVE item (pump reports); undefined when nowhere active. */
  private async locateActive(id: string | undefined): Promise<{ p: ProjectRuntime; item: DevflowItem } | undefined> {
    if (id === undefined || id === '') return undefined
    for (const project of this.runtimes.values()) {
      try {
        await this.ensureLoaded(project)
      } catch {
        // surfaced through the panel per-project error; report stays graceful
      }
      if (project.store === null) continue
      const item = project.store.items.find(i => i.id === id && i.status === 'active')
      if (item !== undefined) return { p: project, item }
    }
    return undefined
  }

  /** Load persisted state and prompts on first touch; concurrent callers share one load. */
  private async ensureLoaded(project: ProjectRuntime): Promise<void> {
    // 缓存进行中的 promise 而非布尔标志：并发调用者等待同一次加载，
    // 而不是在加载完成前被“已加载”的假象放行后撞上未就绪的 store
    project.loading ??= this.loadFromDisk(project).then(() => {
      project.loadError = null
    }, (error: unknown) => {
      project.loadError = describeUnknown(error) // 面板切到该项目时可见
      project.loading = null // 失败后清空缓存，下次调用可重试，避免永久卡死
      throw error
    })
    await project.loading
  }

  /** Best-effort load of every project; failures land in each project's loadError. */
  private async ensureAllLoaded(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async (project) => {
      try {
        await this.ensureLoaded(project)
      } catch {
        // recorded as project.loadError; the partition that is actually
        // addressed throws its own error with that text
      }
    }))
  }

  /** Read one project's `state.json` and `prompts.json` into memory. */
  private async loadFromDisk(project: ProjectRuntime): Promise<void> {
    const raw = await this.readFile(project, ['state.json'])
    project.store = raw !== null ? JSON.parse(raw) as DevflowState : this.freshState()
    if (typeof project.store.mainBusy !== 'string') project.store.mainBusy = null
    if (!Array.isArray(project.store.worktrees)) project.store.worktrees = []
    const promptsRaw = await this.readFile(project, ['prompts.json'])
    if (promptsRaw !== null) {
      try {
        project.customPrompts = JSON.parse(promptsRaw) as Record<string, string>
      } catch {
        project.customPrompts = {}
      }
    }
  }

  /** Empty initial state. */
  private freshState(): DevflowState {
    return { seq: 1, items: [], error: null, note: null, mainBusy: null, worktrees: [] }
  }

  private requireState(project: ProjectRuntime): DevflowState {
    if (project.store === null) throw new Error(`devflow: 项目 ${project.name} 状态未加载`)
    return project.store
  }

  private activeItems(project: ProjectRuntime): DevflowItem[] {
    return this.requireState(project).items.filter(i => i.status === 'active')
  }

  /** Highest value-weighted ready item of one project. */
  private pickBest(project: ProjectRuntime): DevflowItem & { score: DevflowScore } {
    const ready = this.requireState(project).items.filter((i): i is DevflowItem & { score: DevflowScore } =>
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
  private log(project: ProjectRuntime, item: DevflowItem, note: string): void {
    const state = this.requireState(project)
    item.log.push({ n: state.seq++, note })
    if (item.log.length > this.logCap) item.log.splice(0, item.log.length - this.logCap)
  }

  /** Persist the whole state atomically. */
  private async save(project: ProjectRuntime): Promise<void> {
    await this.writeFile(project, 'state.json', JSON.stringify(this.requireState(project), null, 2))
  }

  /** Resolve a path against the fs service. */
  private async resolve(path: string): Promise<FsTarget> {
    return await this.ctx.fs.resolve(path)
  }

  /** Write under one project's `.devflow/` with its workspace-write policy. */
  private async writeFile(project: ProjectRuntime, rel: string, content: string): Promise<string> {
    const target = await this.resolve(`${project.dir}/${rel}`)
    await this.ctx.fs.writeText(target, content, undefined, undefined, project.policy)
    return target.displayPath
  }

  /** Read the first existing candidate under one project's `.devflow/`. */
  private async readFile(project: ProjectRuntime, candidates: readonly string[]): Promise<string | null> {
    for (const rel of candidates) {
      try {
        const content = await this.ctx.fs.readText(await this.resolve(`${project.dir}/${rel}`))
        if (content !== '') return content
      } catch {
        // try next candidate
      }
    }
    return null
  }

  /** Abort the in-flight model call for one item, marking the intent. */
  private abortActive(project: ProjectRuntime, itemId: string): void {
    if (project.activeController !== null) {
      project.cancelRequestedId = itemId
      project.activeController.abort()
    }
  }

  /** Schedule an immediate tick for one project after a mutation. */
  private kickProject(project: ProjectRuntime): void {
    Promise.resolve().then(() => { void this.tickProject(project) }).catch(() => undefined)
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

  /** Wire-safe projection of one project's items for the panel. */
  private projectView(project: ProjectRuntime, directory: readonly DevflowProjectInfo[]): DevflowView {
    const state = this.requireState(project)
    return {
      busy: project.busy,
      note: state.note ?? null,
      error: state.error ?? null,
      project: project.key,
      projects: directory,
      ignoredRoots: this.ignoredRoots,
      waitingTotal: this.waitingTotal(),
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

  /** Waiting-queue total across every loaded project (trigger badge). */
  private waitingTotal(): number {
    let total = 0
    for (const project of this.runtimes.values()) {
      if (project.store === null) continue
      total += project.store.items.filter(i => i.questions !== null
        && i.status !== 'active' && i.status !== 'paused').length
    }
    return total
  }
}

export default DevflowService
