/**
 * Read-only adapter over the harness model surface — the single contact
 * point between this plugin and the harness model LIST/ACTIVE APIs (the
 * per-call execution contact lives in the scheduler, D15). Output passes
 * through an explicit field whitelist: only display-necessary fields cross
 * into plugin memory and the Remote channel. Whole-object spreads of
 * harness-returned values are forbidden here (D1) — those objects may carry
 * credential-adjacent fields, and this file is the one place to keep them
 * out.
 *
 * @module @deepseek-ai/dsh-devflow/src/models
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Whitelisted model descriptor shown in the panel dropdown. `id` is the
 * stable `${provider}/${model}` value stored in settings and routed on at
 * call time; `label` is the human-facing name. Adding any field requires a
 * fresh sensitive-field audit first (design D1).
 */
export interface ModelInfo {
  readonly id: string
  readonly label: string
}

/** Structural slice of `ctx.llm` this adapter consumes. */
interface LlmFace {
  listProviders(): readonly { id: string, name: string }[]
  listModels(provider: string): Promise<readonly {
    provider: string
    id: string
    name: string
    description?: string
  }[]>
}

/** Structural slice of `ctx.agentDefaultModel` for the active selection. */
interface DefaultModelFace {
  currentSelection(): { provider: string, model: string } | undefined
}

/**
 * List every model the harness currently advertises across its registered
 * providers. An empty result is legal (harness configured with nothing) and
 * consumers degrade per design D21 — it is never reported as drift.
 * @param ctx - host context.
 * @returns whitelisted model descriptors, provider order then model order.
 */
export async function listHarnessModels(ctx: Context): Promise<ModelInfo[]> {
  const llm = ctx.get('llm') as LlmFace | undefined
  if (llm === undefined) return []
  const out: ModelInfo[] = []
  for (const provider of llm.listProviders()) {
    let models: LlmFace['listModels'] extends (...args: never) => Promise<infer R> ? R : never
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue // one opaque provider must not blank the whole catalog
    }
    for (const model of models) {
      // Explicit whitelist mapping only — never spread the source object.
      out.push({
        id: `${model.provider}/${model.id}`,
        label: model.name === model.id ? model.name : `${model.name} (${model.provider}/${model.id})`,
      })
    }
  }
  return out
}

/**
 * The harness-active model selection, mapped to the same whitelisted id
 * form. Null when no selection exists (fallback surfaces this as a note).
 * @param ctx - host context.
 */
export function activeHarnessModel(ctx: Context): { provider: string, model: string } | null {
  const service = ctx.get('agentDefaultModel') as DefaultModelFace | undefined
  if (service === undefined) return null
  try {
    const selection = service.currentSelection()
    if (selection === undefined) return null
    return { provider: selection.provider, model: selection.model }
  } catch {
    return null
  }
}
