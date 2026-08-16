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
  readonly log: readonly DevflowLogLine[]
}

/** Whole panel projection. */
export interface DevflowView {
  readonly busy: boolean
  readonly note: string | null
  readonly error: string | null
  readonly items: readonly DevflowItemView[]
}

/** Remote: submit a raw requirement or bug into the pool. */
export interface DevflowSubmitRequest {
  readonly kind: 'requirement' | 'bug'
  readonly text: string
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
}

/** Model tool: next pump task description. */
export interface DevflowPumpTask {
  readonly type: 'implement' | 'fix-code' | 'verify' | 'merge'
  readonly itemId: string
  readonly title: string
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
