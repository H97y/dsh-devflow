/**
 * Cold-boot autonomy coverage: after a process restart with no panel traffic,
 * the tick timer itself must (re)create the project runtimes from the
 * registry + discovery and advance a persisted `ready` item — the exact
 * freeze reported in the field (item stuck at ready because runtimes were
 * only created lazily by Remote calls, and a stalled lane kept busy=true
 * forever with no watchdog).
 *
 * The service needs llm/fs/tools; fs is faked in-memory and llm streams are
 * pre-scripted. Only the state-machine skeleton is exercised: load → admit
 * → design. No model text matters here.
 * @module @deepseek-ai/dsh-devflow/tests/boot
 */

import { clearInterval } from 'node:timers'
import { describe, expect, it } from 'vitest'
// The BUILT artifact: the source uses @Remote decorators that the build
// pipeline lowers (tsdown plugin); vitest's transform does not, so the
// runtime-faithful target is lib/index.js.
import { DevflowService } from '../lib/index.js'

interface FakeTarget {
  displayPath: string
}

interface FakeLlmChunk {
  type: string
  text?: string
  reason?: { kind: string }
}

/** Minimal in-memory fs double: resolve/listDir/readText/writeText. */
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

/** Scripted stream: the recorded chunks, or an eternal hang when null. */
function makeFakeLlm(chunks: FakeLlmChunk[] | null, hangCounter: { count: number }): unknown {
  return {
    stream: (_options: unknown) => ({
      async *[Symbol.asyncIterator]() {
        if (chunks === null) {
          hangCounter.count++
          await new Promise<void>(() => undefined)
          return
        }
        for (const chunk of chunks) yield chunk
      },
    }),
  }
}

/** A ready item on disk, frozen mid-pool (the field incident's shape). */
function readyItem(): PersistedItem {
  return {
    id: 'demo-abcd-r1',
    kind: 'requirement',
    raw: '原文',
    title: '演示需求',
    status: 'ready',
    size: 'small',
    score: { value: 4, completeness: 4 },
    refined: { context: 'ctx', acceptance: [], scope: '' },
    questions: null,
    rejectReason: '',
    resumeTo: null,
    pipeline: null,
    log: [{ n: 2, note: '投入需求池' }, { n: 3, note: '精炼完成' }],
  }
}

function persistedState(): string {
  return JSON.stringify({
    seq: 4,
    items: [readyItem()],
    error: null,
    note: null,
    mainBusy: null,
    worktrees: [],
  })
}

/** Build the service against fakes; tickIntervalMs=1 keeps the test fast. */
function bootService(files: Map<string, string>, llm: unknown): DevflowService {
  const ctx = {
    fs: makeFakeFs(files),
    llm,
    tools: { register: () => () => undefined },
    // Key-aware service lookup: the default-model selection service exists
    // (chat() needs it); the optional directory picker does not.
    get: (key: string) => key === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) }
      : undefined,
    effect: () => () => undefined,
    logger: { error: () => undefined },
    on: () => () => undefined,
    // cordis Service base registers itself through ctx.reflect.provide.
    reflect: { provide: () => undefined },
  }
  return new DevflowService(ctx as never, {
    root: '/ws/demo',
    maxActive: 3,
    maxWorktrees: 2,
    logCap: 40,
    tickIntervalMs: 1,
  })
}

/** Poll the persisted state until the predicate passes (bounded wait). */
async function untilTrue(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return check()
}

interface PersistedItem {
  id: string
  status: string
  pipeline: {
    artifacts: { design: string }
    running: boolean
    error: { stage: string, message: string } | null
  } | null
}

interface PersistedState {
  items: PersistedItem[]
}

function readItem(files: Map<string, string>): PersistedItem | undefined {
  const raw = files.get('/ws/demo/.devflow/state.json')
  if (raw === undefined) return undefined
  const state = JSON.parse(raw) as PersistedState
  return state.items.find(candidate => candidate.id === 'demo-abcd-r1')
}

/** Test-only view of the private runtime map (watchdog assertions). */
interface RuntimeProbe {
  busy: boolean
  tickStartedAt: number
  stallAborted: boolean
}

interface TimerHolder {
  timer?: ReturnType<typeof setInterval>
}

/** Stop the service's tick timer so the test worker can exit cleanly. */
function stopService(service: DevflowService): void {
  const timer = (service as unknown as TimerHolder).timer
  if (timer !== undefined) clearInterval(timer)
}

function runtimeOf(service: DevflowService): RuntimeProbe {
  const map = (service as unknown as { runtimes: Map<string, RuntimeProbe> }).runtimes
  // Exactly one partition exists in these scenarios; the key embeds a path
  // hash, so take the sole entry instead of hardcoding it.
  const first = map.values().next()
  return first.value as RuntimeProbe
}

describe('devflow cold-boot autonomy', () => {
  it('admits a persisted ready item with no Remote call at all', async () => {
    const files = new Map<string, string>([
      // workspace root IS a project → single partition at /ws/demo
      ['/ws/demo/.git/HEAD', 'ref: refs/heads/main'],
      ['/ws/demo/AGENTS.md', '# demo'],
      ['/ws/demo/.devflow/state.json', persistedState()],
    ])
    const llm = makeFakeLlm([
      { type: 'text-delta', text: '{"design":"# 设计","questions":[]}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ], { count: 0 })
    const service = bootService(files, llm)
    try {
    // The regression: before the fix, nothing created the runtime without a
    // Remote call, so the item stayed ready forever with the panel closed.
    const admitted = await untilTrue(() => readItem(files)?.status === 'active')
    expect(admitted).toBe(true)
    // And the design stage (auto, LLM-backed) completes with the scripted
    // stream: the pipeline keeps moving past admission.
    const designed = await untilTrue(() => readItem(files)?.pipeline?.artifacts?.design === '# 设计')
    expect(designed).toBe(true)
    } finally {
      stopService(service)
    }
  })

  it('force-frees a lane whose tick never returns (stall watchdog)', async () => {
    const files = new Map<string, string>([
      ['/ws/demo/.git/HEAD', 'ref: refs/heads/main'],
      ['/ws/demo/.devflow/state.json', persistedState()],
    ])
    // A stream that never yields and never finishes: the design chat hangs.
    const hang = { count: 0 }
    const service = bootService(files, makeFakeLlm(null, hang))
    try {
    // Wait until the hung design chat parks the lane (busy forever in the
    // pre-fix code), then fake the watchdog horizon by back-dating the tick
    // start beyond STALL_WARN_MS + STALL_FORCE_MS.
    const parked = await untilTrue(() => hang.count > 0)
    expect(parked).toBe(true)
    const runtime = runtimeOf(service)
    expect(runtime.busy).toBe(true)
    // Between the two horizons: beat 1 aborts, beat 2 has not yet qualified.
    runtime.tickStartedAt = Date.now() - (10 * 60_000 + 10_000)
    // Beat 1: the watchdog aborts (stage 1).
    const aborted = await untilTrue(() => runtime.stallAborted)
    expect(aborted).toBe(true)
    // Beyond the force horizon: beat 2 frees the lane and converts the
    // zombie's running flag into a sticky, retryable error on the item.
    runtime.tickStartedAt = Date.now() - (11 * 60_000 + 61_000)
    const freed = await untilTrue(() => !runtime.busy)
    expect(freed).toBe(true)
    const errored = await untilTrue(() => readItem(files)?.pipeline !== null
      && readItem(files)?.pipeline?.error?.message != null)
    expect(errored).toBe(true)
    } finally {
      stopService(service)
    }
  })
})
