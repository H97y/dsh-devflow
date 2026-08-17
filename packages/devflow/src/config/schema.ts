/**
 * Settings schema for the unified configuration entry: the Settings shape,
 * defaults, and structured validation whose error list serves two consumers —
 * `config.set` throws on it, `config.get` passes it to the panel as load
 * warnings (D18).
 *
 * @module @deepseek-ai/dsh-devflow/src/config/schema
 */

/** Pipeline stages a per-stage model override can target. */
export const STAGE_IDS = ['refine', 'design', 'plan', 'review', 'codeReview', 'report'] as const

export type StageId = (typeof STAGE_IDS)[number]

/** Chinese labels for the settings panel's stage list. */
export const STAGE_LABELS: Record<StageId, string> = {
  refine: '需求精炼',
  design: '设计',
  plan: '计划',
  review: '评审·设计计划',
  codeReview: '代码评审',
  report: '开发报告',
}

/** Unified plugin settings persisted at `<root>/.devflow/settings.json`. */
export interface Settings {
  version: 1
  /**
   * Per-stage model overrides. A stage key maps to `${provider}/${model}` —
   * the provider is required because GenerateOptions routes on it. Stages
   * absent from this map fall back to the harness-active model (D2).
   */
  stageModels: Partial<Record<StageId, string>>
}

/** Factory defaults: no overrides, every stage uses the harness model. */
export function defaultSettings(): Settings {
  return { version: 1, stageModels: {} }
}

/** Parse one stageModels value: `provider/model` with both parts non-empty. */
export function parseStageModel(value: string): { provider: string, model: string } | null {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash >= value.length - 1) return null
  const provider = value.slice(0, slash).trim()
  const model = value.slice(slash + 1).trim()
  if (provider === '' || model === '' || value.includes(' ', slash)) return null
  return { provider, model }
}

/**
 * Validate an arbitrary parsed value against the Settings shape.
 * @param input - the parsed JSON value (or anything).
 * @returns structured errors; empty list means the value is a valid Settings.
 */
export function validateSettings(input: unknown): string[] {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['配置根必须是对象']
  }
  const record = input as Record<string, unknown>
  if (record.version !== 1) errors.push(`version 必须为 1，收到 ${JSON.stringify(record.version)}`)
  if (typeof record.stageModels !== 'object' || record.stageModels === null || Array.isArray(record.stageModels)) {
    errors.push('stageModels 必须是对象')
    return errors
  }
  const stageSet = new Set<string>(STAGE_IDS)
  for (const [stage, value] of Object.entries(record.stageModels)) {
    if (!stageSet.has(stage)) {
      errors.push(`未知阶段 "${stage}"（可用: ${STAGE_IDS.join(', ')}）`)
      continue
    }
    if (typeof value !== 'string' || value === '') {
      errors.push(`阶段 ${stage} 的模型必须是非空字符串`)
      continue
    }
    if (parseStageModel(value) === null) {
      errors.push(`阶段 ${stage} 的模型格式须为 provider/model，收到 "${value}"`)
    }
  }
  return errors
}
