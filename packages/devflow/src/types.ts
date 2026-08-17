/**
 * Public type face of the devflow domain: persisted state, panel projections,
 * Remote request/response payloads, and the model tool's report arguments.
 * Everything crossing the Client RPC boundary is lossless JSON by
 * construction (plain objects, arrays, strings, numbers, booleans, null).
 *
 * @module @deepseek-ai/dsh-devflow/types
 */

/** Lifecycle status of one pool item. */
export type DevflowItemStatus =
  | 'raw'
  | 'refining'
  | 'needs-user'
  | 'ready'
  | 'active'
  | 'done'
  | 'rejected'
  | 'paused'

/** Pipeline stages, in execution order. */
export type DevflowStage =
  | 'design'
  | 'plan'
  | 'review-dp'
  | 'implement'
  | 'code-review'
  | 'fix-code'
  | 'verify'
  | 'merge'
  | 'report'

/** Implementation size class driving workspace routing. */
export type DevflowSize = 'small' | 'medium' | 'large'

/** One option of a user question. */
export interface DevflowQuestionOption {
  readonly label: string
  readonly desc: string
}

/** A blocking question with a recommended option. */
export interface DevflowQuestion {
  readonly id?: string
  readonly q: string
  readonly options: readonly DevflowQuestionOption[]
  readonly recommend?: string
}

/** Refinement value/completeness scores, each 0..5. */
export interface DevflowScore {
  readonly value: number
  readonly completeness: number
}

/** The refined requirement produced by the refine stage. */
export interface DevflowRefined {
  context: string
  acceptance: string[]
  scope: string
}

/** One user answer to an earlier question. */
export interface DevflowAnswer {
  readonly q: string
  readonly a: string
}

/** Workspace allocation for one item's tool stages. */
export interface DevflowWorkspace {
  readonly kind: 'main' | 'worktree'
  readonly path: string
  readonly branch: string | null
}

/** One review-round or code-review finding. */
export interface DevflowIssue {
  readonly severity: string
  readonly what: string
  readonly why: string
  readonly fix: string
}

/** One recorded review round. */
export interface DevflowReviewRecord {
  readonly phase: 'dp' | 'code'
  readonly round: number
  readonly verdict: string
  readonly issues: readonly DevflowIssue[]
}

/** One implementation or fix report accepted from the model tool. */
export interface DevflowChangeRecord {
  readonly summary: string
  readonly changedFiles: readonly string[]
}

/** One web-verification record. */
export interface DevflowVerifyRecord {
  readonly verified: boolean
  readonly detail: string
}

/** All durable artifacts of one item's pipeline. */
export interface DevflowArtifacts {
  design: string
  plan: string
  reviews: DevflowReviewRecord[]
  impls: DevflowChangeRecord[]
  fixes: DevflowChangeRecord[]
  verifies: DevflowVerifyRecord[]
  report: string
}

/** On-disk artifact paths, reported to the session pump. */
export interface DevflowFiles {
  design: string | null
  plan: string | null
  report: string | null
}

/** Waiting-queue entry: the stage that produced questions plus the questions. */
export interface DevflowWaiting {
  readonly stage: DevflowStage
  readonly questions: readonly DevflowQuestion[]
}

/** Per-item pipeline state. */
export interface DevflowPipeline {
  stage: DevflowStage
  round: number
  waiting: DevflowWaiting | null
  error: { stage: DevflowStage; message: string } | null
  pendingFix: DevflowIssue[] | null
  answers: DevflowAnswer[]
  running: boolean
  stageNote: string | null
  workspace: DevflowWorkspace | null
  resourceWaiting: 'workspace' | 'worktree' | null
  artifacts: DevflowArtifacts
  files: DevflowFiles
}

/** One persisted log line. */
export interface DevflowLogLine {
  readonly n: number
  readonly note: string
}

/** One pool item (the whole persisted unit). */
export interface DevflowItem {
  id: string
  kind: 'requirement' | 'bug'
  raw: string
  title: string
  status: DevflowItemStatus
  size: DevflowSize | null
  score: DevflowScore | null
  refined: DevflowRefined | null
  questions: readonly DevflowQuestion[] | null
  rejectReason: string
  resumeTo: 'raw' | 'needs-user' | 'ready' | null
  pipeline: DevflowPipeline | null
  log: DevflowLogLine[]
}

/** One registered worktree slot. */
export interface DevflowWorktreeRow {
  readonly id: string
  readonly path: string
  readonly branch: string
}

/** How one project partition entered the panel directory. */
export type DevflowProjectOrigin = 'workspace' | 'scan' | 'manual'

/** One project partition in the panel directory (isolation unit). */
export interface DevflowProjectInfo {
  /** Filesystem-safe partition key; prefixes this project's item ids. */
  readonly key: string
  /** Switcher label (the workspace root's basename). */
  readonly name: string
  /** The workspace root owning this project's `.devflow/` and workspaces. */
  readonly root: string
  /** How the partition was discovered: the dsh workspace itself, an
   * auto-scan hit underneath it, or a manually added folder. */
  readonly origin: DevflowProjectOrigin
}

/** Remote: scope selector for project-partitioned calls (null = default). */
export interface DevflowStateRequest {
  readonly project: string | null
}

/** Whole persisted state (`.devflow/state.json`). */
export interface DevflowState {
  seq: number
  items: DevflowItem[]
  error: string | null
  note: string | null
  mainBusy: string | null
  worktrees: DevflowWorktreeRow[]
}

/** Panel projection of one item (safe to cross the wire). */
export interface DevflowItemView {
  readonly id: string
  readonly kind: 'requirement' | 'bug'
  readonly title: string
  readonly status: DevflowItemStatus
  readonly size: DevflowSize | null
  readonly score: DevflowScore | null
  readonly running: boolean
  readonly note: string | null
  readonly preview: string
  readonly rejectReason: string
  readonly questions: readonly DevflowQuestion[] | null
  readonly waitingStage: DevflowStage | null
  readonly stage: DevflowStage | null
  readonly round: number
  readonly error: string | null
  readonly workspaceKind: 'main' | 'worktree' | null
  readonly workspacePath: string | null
  readonly workspaceBranch: string | null
  readonly resourceWaiting: 'workspace' | 'worktree' | null
  readonly reportFile: string | null
  /** True while a host-spawned auto-pump agent owns this item's tool stage. */
  readonly pumpRunning: boolean
  /** True while that agent has an ask_user_question awaiting the human. */
  readonly pumpWaitingUser: boolean
  /** The spawned agent's session id (panel hint / jump reference). */
  readonly pumpSessionId: string | null
  readonly log: readonly DevflowLogLine[]
}

/** Auto-pump projection for the panel (per viewed project). */
export interface DevflowPumpView {
  /** Whether this project's settings enable host-spawned pump agents. */
  readonly enabled: boolean
  /** False when the host lacks the agents service (auto-pump impossible). */
  readonly available: boolean
  /** Live spawned runs for this project (waiting-user ones included). */
  readonly activeCount: number
  /** Deployment-wide concurrent-run cap (composition config). */
  readonly maxConcurrent: number
  /** Effective `${provider}/${model}` route, or null = harness-active. */
  readonly model: string | null
}

/** Whole panel projection: one project's items plus the project directory. */
export interface DevflowView {
  readonly busy: boolean
  readonly note: string | null
  readonly error: string | null
  /** Key of the project these items belong to. */
  readonly project: string | null
  /** Every visible project partition (switcher + manage directory). */
  readonly projects: readonly DevflowProjectInfo[]
  /** Roots hidden via the manage dialog (restorable by re-adding). */
  readonly ignoredRoots: readonly string[]
  /** Waiting-queue total across every loaded project (trigger badge). */
  readonly waitingTotal: number
  /** Auto-pump status of the viewed project. */
  readonly pump: DevflowPumpView
  readonly items: readonly DevflowItemView[]
}

/** Remote: submit a raw requirement or bug into one project's pool. */
export interface DevflowSubmitRequest {
  readonly kind: 'requirement' | 'bug'
  readonly text: string
  /** Target project key (null = default project). */
  readonly project: string | null
}

/** Remote: submit result. */
export interface DevflowSubmitResult {
  readonly ok: boolean
  readonly id: string
}

/** Remote: answer waiting-queue or refinement questions. */
export interface DevflowAnswerRequest {
  readonly itemId: string
  readonly stage: DevflowStage | null
  readonly answers: readonly DevflowAnswer[]
}

/** Remote: generic acknowledged outcome with an optional reason. */
export interface DevflowMutationResult {
  readonly ok: boolean
  readonly reason?: string
}

/** Remote: read one artifact's text (clipped). */
export interface DevflowArtifactRequest {
  readonly itemId: string
  readonly name: 'design' | 'plan' | 'report' | 'reviews'
}

/** Remote: prompt-template directory. */
export interface DevflowPromptsView {
  readonly custom: Record<string, string>
  readonly defaults: Record<string, string>
  readonly vars: Record<string, readonly string[]>
}

/** Remote: set (or clear, with null) one stage's custom template. */
export interface DevflowPromptSetRequest {
  readonly stage: string
  readonly template: string | null
  /** Target project key (null = default project). */
  readonly project: string | null
}

/** Remote: add one project folder (manual add; also un-ignores the path). */
export interface DevflowProjectAddRequest {
  /** Absolute folder path (from the picker, the browse flow, or pasted). */
  readonly path: string
}

/** Remote: result of adding a project. */
export interface DevflowProjectAddResult {
  readonly ok: boolean
  readonly reason?: string
  /** Key of the added (or already-present) project partition. */
  readonly key: string | null
}

/** Remote: hide one project from the directory (discoverable state kept). */
export interface DevflowProjectRemoveRequest {
  readonly key: string
}

/** Remote: force a workspace rescan now. */
export interface DevflowProjectScanRequest {
  readonly rescan: boolean
}

/** Settings document persisted at `<project-root>/.devflow/settings.json` (wire shape). */
export interface DevflowSettings {
  readonly version: 1
  /** StageId → `${provider}/${model}`; absent stages fall back to the harness model. */
  readonly stageModels: { readonly [stage: string]: string }
  /**
   * Auto-pump section (optional). `model` is `${provider}/${model}` or ''
   * (follow the harness-active model); absent = disabled defaults.
   */
  readonly pump?: {
    readonly enabled: boolean
    readonly model: string
  }
}

/** Remote: config.get — effective settings plus load-fallback warnings. */
export interface DevflowSettingsView {
  readonly settings: DevflowSettings
  readonly warnings: readonly string[]
}

/** Remote: config.set — project scope plus the next whole settings document. */
export interface DevflowConfigSetRequest {
  readonly project: string | null
  readonly settings: DevflowSettings
}

/** Remote: one whitelisted harness model descriptor (config.models). */
export interface DevflowModelInfo {
  readonly id: string
  readonly label: string
}

/** Remote: which folder-picking interaction the host offers. */
export interface DevflowPickCapabilityResult {
  readonly kind: 'native' | 'browse' | 'none'
}

/** Remote: one native OS chooser round trip. */
export interface DevflowPickNativeResult {
  /** The chosen absolute path, or null when the operator cancelled. */
  readonly path: string | null
}

/** Remote: one browser row of a listed directory level. */
export interface DevflowDirEntry {
  readonly name: string
  readonly path: string
  readonly hidden: boolean
}

/** Remote: one directory level plus its ancestry (browse flow). */
export interface DevflowDirListing {
  readonly path: string
  readonly home: string
  readonly crumbs: readonly DevflowDirEntry[]
  readonly entries: readonly DevflowDirEntry[]
  readonly truncated: boolean
}

/** Remote: list one directory level for the browse flow. */
export interface DevflowListDirRequest {
  /** Absolute directory to list; null lists the home directory. */
  readonly path: string | null
}

/** Model tool: next pump task description. */
export interface DevflowPumpTask {
  readonly type: 'implement' | 'fix-code' | 'verify' | 'merge'
  readonly itemId: string
  readonly title: string
  /** Owning project partition key. */
  readonly project: string
  /** Owning project's workspace root (absolute). */
  readonly projectRoot: string
  readonly size: DevflowSize | null
  readonly design: string | null
  readonly plan: string | null
  readonly issues: readonly DevflowIssue[]
  readonly acceptance: readonly string[]
  readonly workspace: DevflowWorkspace | null
  readonly hint: string
}

/** Model tool: report a pump task's outcome. */
export interface DevflowReportArgs {
  readonly action: 'next' | 'report'
  readonly itemId?: string
  readonly summary?: string
  readonly changedFiles?: string
  readonly verified?: string
  readonly detail?: string
  readonly questions?: string
}

/** Model tool: report outcome text. */
export interface DevflowReportResult {
  readonly text: string
}
