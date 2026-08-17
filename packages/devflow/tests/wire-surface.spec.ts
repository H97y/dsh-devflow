/**
 * Wire-level regression coverage: the vendored typert quartet must carry the
 * whole live @Remote surface. v0.3.0 added the pump section to
 * DevflowSettings, the pump projection to DevflowView, and the pump item
 * fields — but the wire was not regenerated, and zod's unknown-key stripping
 * silently deleted `pump` on every config.set crossing: the panel's auto-pump
 * toggle saved, then flipped straight back to off. These tests parse through
 * the BUILT wire codecs (lib/, copied from wire/ by pnpm build) so a stale
 * quartet fails here loudly instead of eating fields in production.
 * @module @deepseek-ai/dsh-devflow/tests/wire-surface
 */

import { describe, expect, it } from 'vitest'
import { TYPERT } from '../lib/typert.host.js'

/** The wire invocation descriptor of one @Remote method. */
function invocationOf(method: string): {
  parameters: { codec: { schema: { parse(input: unknown): unknown } } }[]
  result: { schema: { parse(input: unknown): unknown } }
} {
  const hit = TYPERT.invocations.find(entry => entry.method === method)
  if (hit === undefined) throw new Error(`wire has no ${method} invocation`)
  return hit as unknown as ReturnType<typeof invocationOf>
}

describe('typert wire surface (regression: pump fields must survive the crossing)', () => {
  it('config.set keeps the pump section of the request settings', () => {
    const wire = invocationOf('config.set')
    const parsed = wire.parameters[0].codec.schema.parse({
      project: null,
      settings: { version: 1, stageModels: {}, pump: { enabled: true, model: 'prov/m-pump' } },
    }) as { settings: { pump?: { enabled: boolean, model: string } } }
    // Before the fix this parsed as undefined: the host saved a pump-less
    // document (defaults) and answered enabled=false — the toggle snapped back.
    expect(parsed.settings.pump).toEqual({ enabled: true, model: 'prov/m-pump' })
  })

  it('config.get / config.set results keep the pump section', () => {
    for (const method of ['config.get', 'config.set']) {
      const wire = invocationOf(method)
      const doc = { version: 1, stageModels: { plan: 'p/m' }, pump: { enabled: true, model: '' } }
      const input = method === 'config.get'
        ? { settings: doc, warnings: ['w'] }
        : doc
      const parsed = wire.result.schema.parse(input) as {
        settings?: { pump?: { enabled: boolean } }, pump?: { enabled: boolean }
      }
      const pump = parsed.settings?.pump ?? parsed.pump
      expect(pump?.enabled).toBe(true)
    }
  })

  it('state keeps the pump projection and the per-item pump fields', () => {
    const wire = invocationOf('state')
    const item = {
      id: 'k-r1', kind: 'requirement', title: 't', status: 'active', size: null, score: null,
      running: false, note: null, preview: 'p', rejectReason: '', questions: null,
      waitingStage: null, stage: 'implement', round: 0, error: null,
      workspaceKind: 'worktree', workspacePath: '/w', workspaceBranch: 'b',
      resourceWaiting: null, reportFile: null,
      pumpRunning: true, pumpWaitingUser: true, pumpSessionId: 'sess-1',
      log: [{ n: 1, note: 'x', at: 0 }],
    }
    const parsed = wire.result.schema.parse({
      busy: false, note: null, error: null, project: 'k', projects: [],
      ignoredRoots: [], waitingTotal: 0,
      pump: { enabled: true, available: true, activeCount: 1, maxConcurrent: 2, model: null },
      items: [item],
    }) as { pump?: { enabled: boolean }, items: { pumpRunning: boolean, pumpWaitingUser: boolean, pumpSessionId: string | null }[] }
    expect(parsed.pump).toEqual({ enabled: true, available: true, activeCount: 1, maxConcurrent: 2, model: null })
    expect(parsed.items[0].pumpRunning).toBe(true)
    expect(parsed.items[0].pumpWaitingUser).toBe(true)
    expect(parsed.items[0].pumpSessionId).toBe('sess-1')
  })
})
