/**
 * Settings store: load/save of `<project-root>/.devflow/settings.json`
 * plus the per-stage model resolver. Settings are per-project (one store
 * per project partition). The harness model state is injected as a
 * parameter (D19) — this module never imports the models adapter and is
 * structurally identical under test mocks and production wiring.
 *
 * Write semantics (D5, explicit): exactly two writer classes exist — the
 * panel's `config.set` and host-internal call sites converged in S7 — both
 * following the same "load → build the next whole document → atomic write"
 * shape. Last write wins; no concurrency protection or optimistic locking
 * (single-user, single-editor assumption).
 *
 * @module @deepseek-ai/dsh-devflow/src/config/store
 */

import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Context } from '@deepseek-ai/cordis'
import { defaultSettings, parseStageModel, validateSettings } from './schema.ts'
import type { Settings, StageId } from './schema.ts'

/** Load outcome: the effective settings plus load-fallback warnings (D18). */
export interface LoadResult {
  readonly settings: Settings
  readonly warnings: string[]
}

/** The harness model state the resolver needs, injected by callers (D19). */
export interface HarnessModelState {
  /** Currently active harness selection, if any. */
  readonly active: { provider: string, model: string } | null
  /** Ids (`provider/model`) of every harness-configured model. */
  readonly configured: readonly string[]
}

/** Resolution outcome for one stage's model (D2/D9). */
export interface StageModelResolution {
  readonly provider: string
  readonly model: string
  readonly source: 'override' | 'fallback'
  readonly note?: string
}

/**
 * Per-project settings store. One instance per runtime root; the fs service
 * and the root-scoped write policy arrive via the constructor, matching the
 * service's per-project runtime shape.
 */
export class SettingsStore {
  private cache: Settings | null = null
  private cacheWarnings: string[] = []

  /**
   * @param ctx - host context carrying fs.
   * @param dir - the project's `.devflow` directory (`<project-root>/.devflow`).
   * @param policy - workspace-write policy scoped to the project root.
   */
  constructor(
    private readonly ctx: Context,
    private readonly dir: string,
    private readonly policy: SandboxExecutionPolicy,
  ) {}

  /** Settings file path helper. */
  private file(): string {
    return `${this.dir}/settings.json`
  }

  /**
   * Load settings (cached after the first hit). File absent → defaults,
   * persisted so the file exists from the first read — deleting the file
   * IS the reset. Unreadable / unknown version / invalid fields →
   * defaults plus warnings, and the original file is never overwritten
   * by the load path.
   */
  async load(): Promise<LoadResult> {
    if (this.cache !== null) return { settings: this.cache, warnings: this.cacheWarnings }
    const raw = await this.read()
    if (raw === null) {
      // No file yet: defaults, persisted so the file exists from the first
      // read. Deleting the file resets to defaults (next load recreates it).
      const settings = defaultSettings()
      await this.persist(settings)
      this.cache = settings
      this.cacheWarnings = []
      return { settings, warnings: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.cache = defaultSettings()
      this.cacheWarnings = ['settings.json 不是合法 JSON，已使用默认配置（原文件未改动）']
      return { settings: this.cache, warnings: this.cacheWarnings }
    }
    const errors = validateSettings(parsed)
    if (errors.length > 0) {
      this.cache = defaultSettings()
      this.cacheWarnings = errors.map(e => `${e}，已使用默认配置（原文件未改动）`)
      return { settings: this.cache, warnings: this.cacheWarnings }
    }
    this.cache = parsed as Settings
    this.cacheWarnings = []
    return { settings: this.cache, warnings: [] }
  }

  /**
   * Validate and persist the next whole settings document (D5: whole-value
   * replacement; the cache invalidates so the change is effective
   * immediately). Returns the persisted document; throws on validation
   * failure without touching the file.
   */
  async save(next: Settings): Promise<Settings> {
    const errors = validateSettings(next)
    if (errors.length > 0) throw new Error(`配置校验失败: ${errors.join('；')}`)
    await this.persist(next)
    this.cache = next
    this.cacheWarnings = []
    return next
  }

  /**
   * Resolve one stage's model against the injected harness state (D2):
   * no override → the harness-active model; override whose id drifted out
   * of the configured list → fallback with a note. Never hard-fails.
   */
  resolveStageModel(stage: StageId, harness: HarnessModelState): StageModelResolution {
    const override = (this.cachedSync()?.stageModels ?? this.lastLoaded?.stageModels)?.[stage]
    if (override === undefined) {
      return this.fallbackResolution(harness, '未配置，回退 harness 当前模型')
    }
    const parsed = parseStageModel(override)
    if (parsed === null) {
      return this.fallbackResolution(harness, `配置格式非法（${override}），回退 harness 当前模型`)
    }
    if (harness.configured.length > 0 && !harness.configured.includes(override)) {
      return this.fallbackResolution(harness, `配置的模型 ${override} 已不在 harness 已配置列表，回退当前模型`)
    }
    return { provider: parsed.provider, model: parsed.model, source: 'override' }
  }

  /** Register the last persisted settings for synchronous resolution. */
  private lastLoaded: Settings | null = null

  /**
   * Sync peek at the loaded settings (null before the first load). Read-only
   * projections (the panel view) use this; anything that must see disk truth
   * goes through {@link load}.
   */
  cached(): Settings | null {
    return this.cache
  }

  private cachedSync(): Settings | null {
    return this.cache
  }

  private fallbackResolution(harness: HarnessModelState, note: string): StageModelResolution {
    if (harness.active === null) {
      // No harness selection either: route to a syntactically valid but
      // empty selection; the chat call will fail loudly downstream.
      return { provider: '', model: '', source: 'fallback', note: `${note}；且 harness 无当前模型` }
    }
    return { provider: harness.active.provider, model: harness.active.model, source: 'fallback', note }
  }

  /**
   * Persist the settings document. The fs service's writeText publishes
   * atomically (its outcome contract), which is the required durability
   * level for a single-user settings file — no tmp+rename dance needed on
   * top of it.
   */
  private async persist(settings: Settings): Promise<void> {
    const target = await this.ctx.fs.resolve(this.file())
    await this.ctx.fs.writeText(target, JSON.stringify(settings, null, 2), undefined, undefined, this.policy)
    this.lastLoaded = settings
  }

  /** Read the settings file; null when absent or unreadable. */
  private async read(): Promise<string | null> {
    try {
      const target: FsTarget = await this.ctx.fs.resolve(this.file())
      const content = await this.ctx.fs.readText(target)
      return content === '' ? null : content
    } catch {
      return null
    }
  }
}
