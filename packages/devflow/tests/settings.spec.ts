/**
 * Coverage for the settings schema/store/models trio: validation errors feed
 * both config.set failures and config.get warnings (D18); load fallbacks
 * never overwrite the file; resolveStageModel's three-state matrix runs on
 * injected harness state (D19); the models adapter whitelists fields and
 * never leaks credential-shaped ones (D1).
 * @module @deepseek-ai/dsh-devflow/tests/settings
 */

import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/config/store.ts'
import type { HarnessModelState } from '../src/config/store.ts'
import { defaultSettings, parseStageModel, validateSettings } from '../src/config/schema.ts'
import { activeHarnessModel, listHarnessModels } from '../src/models.ts'
import type { Context } from '@deepseek-ai/cordis'

/** In-memory fs double with the slice the store consumes. */
function fakeCtx(files: Map<string, string>): Context {
  const ctx = {
    fs: {
      resolve: async (path: string) => ({ displayPath: path }),
      readText: async (t: { displayPath: string }) => {
        const content = files.get(t.displayPath)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      writeText: async (t: { displayPath: string }, content: string) => {
        files.set(t.displayPath, content)
      },
    },
    get: () => undefined,
  }
  return ctx as unknown as Context
}

const POLICY = { mode: 'workspace-write' as const, workspaceRoot: '/ws/demo' }

function storeFor(files: Map<string, string>): SettingsStore {
  return new SettingsStore(fakeCtx(files), '/ws/demo/.devflow', POLICY)
}

describe('settings schema', () => {
  it('accepts a valid document and rejects each invalid shape with a reason', () => {
    expect(validateSettings({ version: 1, stageModels: { plan: 'prov/model' } })).toEqual([])
    expect(validateSettings({ version: 2, stageModels: {} })).toHaveLength(1)
    expect(validateSettings(null)).toEqual(['配置根必须是对象'])
    expect(validateSettings({ version: 1, stageModels: { nope: 'a/b' } })[0]).toContain('未知阶段')
    expect(validateSettings({ version: 1, stageModels: { plan: 'nomodel' } })[0]).toContain('provider/model')
  })

  it('parses provider/model pairs and rejects the rest', () => {
    expect(parseStageModel('prov/model')).toEqual({ provider: 'prov', model: 'model' })
    expect(parseStageModel('prov/')).toBeNull()
    expect(parseStageModel('/model')).toBeNull()
    expect(parseStageModel('plain')).toBeNull()
  })
})

describe('settings store', () => {
  it('creates defaults on first load and persists them (D20 trigger: absence)', async () => {
    const files = new Map<string, string>()
    const store = storeFor(files)
    const { settings, warnings } = await store.load()
    expect(settings).toEqual(defaultSettings())
    expect(warnings).toEqual([])
    expect(files.get('/ws/demo/.devflow/settings.json')).toContain('"version": 1')
  })

  it('falls back to defaults with warnings on corrupt JSON without overwriting (D18)', async () => {
    const files = new Map<string, string>([['/ws/demo/.devflow/settings.json', '{broken']])
    const store = storeFor(files)
    const { settings, warnings } = await store.load()
    expect(settings).toEqual(defaultSettings())
    expect(warnings[0]).toContain('不是合法 JSON')
    expect(files.get('/ws/demo/.devflow/settings.json')).toBe('{broken')
  })

  it('falls back on unknown version and invalid fields with warnings', async () => {
    const files = new Map<string, string>([['/ws/demo/.devflow/settings.json', '{"version":7,"stageModels":{}}']])
    const first = await storeFor(files).load()
    expect(first.warnings[0]).toContain('version')

    const files2 = new Map<string, string>([['/ws/demo/.devflow/settings.json', '{"version":1,"stageModels":{"plan":"bad"}}']])
    const second = await storeFor(files2).load()
    expect(second.warnings[0]).toContain('provider/model')
  })

  it('save validates first: rejects without touching the file, accepts and round-trips', async () => {
    const files = new Map<string, string>()
    const store = storeFor(files)
    await expect(store.save({ version: 1, stageModels: { design: 'no-slash' } })).rejects.toThrow('配置校验失败')
    expect(files.has('/ws/demo/.devflow/settings.json')).toBe(false)
    const saved = await store.save({ version: 1, stageModels: { design: 'prov/model-x' } })
    expect(saved.stageModels.design).toBe('prov/model-x')
    // A fresh store reads the persisted document back.
    const re = await storeFor(files).load()
    expect(re.settings.stageModels.design).toBe('prov/model-x')
    expect(re.warnings).toEqual([])
  })

  it('resolves the three-state matrix from injected harness state (D19/D2)', async () => {
    const files = new Map<string, string>([['/ws/demo/.devflow/settings.json', '{"version":1,"stageModels":{"plan":"p/m-plan"}}']])
    const store = storeFor(files)
    await store.load()
    const harness: HarnessModelState = {
      active: { provider: 'p', model: 'm-active' },
      configured: ['p/m-plan', 'p/m-active'],
    }
    expect(store.resolveStageModel('plan', harness)).toEqual({
      provider: 'p', model: 'm-plan', source: 'override',
    })
    const unset = store.resolveStageModel('design', harness)
    expect(unset.source).toBe('fallback')
    expect(unset.model).toBe('m-active')
    expect(unset.note).toContain('未配置')
    const drifted = store.resolveStageModel('plan', { ...harness, configured: ['p/m-active'] })
    expect(drifted.source).toBe('fallback')
    expect(drifted.note).toContain('已不在 harness 已配置列表')
  })
})

describe('models adapter', () => {
  it('whitelists fields: credential-shaped properties never cross over (D1)', async () => {
    const ctx = {
      fs: {},
      get: (key: string) => {
        if (key !== 'llm') return undefined
        return {
          listProviders: () => [{ id: 'prov', name: 'Prov' }],
          listModels: async () => [{
            provider: 'prov',
            id: 'm1',
            name: 'Model One',
            description: 'desc',
            // credential-shaped extras a hostile/evolving backend might add:
            apiKey: 'sk-secret',
            baseUrl: 'https://internal',
          }],
        }
      },
    } as unknown as Context
    const models = await listHarnessModels(ctx)
    expect(models).toEqual([{ id: 'prov/m1', label: 'Model One (prov/m1)' }])
    expect(JSON.stringify(models)).not.toContain('sk-secret')
    expect(JSON.stringify(models)).not.toContain('baseUrl')
  })

  it('returns [] with no llm service and skips a failing provider (D21 precondition)', async () => {
    expect(await listHarnessModels(fakeCtx(new Map()))).toEqual([])
    const ctx = {
      fs: {},
      get: (key: string) => {
        if (key !== 'llm') return undefined
        return {
          listProviders: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
          listModels: async (provider: string) => {
            if (provider === 'a') throw new Error('opaque')
            return [{ provider: 'b', id: 'm', name: 'M' }]
          },
        }
      },
    } as unknown as Context
    const models = await listHarnessModels(ctx)
    expect(models).toEqual([{ id: 'b/m', label: 'M (b/m)' }])
  })

  it('activeHarnessModel maps the selection or null', () => {
    const withSelection = {
      fs: {},
      get: () => ({ currentSelection: () => ({ provider: 'p', model: 'm' }) }),
    } as unknown as Context
    expect(activeHarnessModel(withSelection)).toEqual({ provider: 'p', model: 'm' })
    const none = { fs: {}, get: () => ({ currentSelection: () => undefined }) } as unknown as Context
    expect(activeHarnessModel(none)).toBeNull()
    expect(activeHarnessModel(fakeCtx(new Map()))).toBeNull()
  })
})
