/**
 * Adaptive poll cadence coverage: the store must poll fast (1.5s) while the
 * main-area page is open for live workbench updates, and drop to the idle
 * rate (10s) once only the sidebar trigger remains — the badge tolerates
 * latency, the workbench does not. Uses a scripted remote + fake timers.
 * @module @deepseek-ai/dsh-devflow/tests/ui-cadence
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevflowUiStore } from '../src/client/devflow-ui.ts'
import type { DevflowRemote, RemoteResult } from '../src/client/devflow-ui.ts'
import type { DevflowView } from '../src/types.ts'

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

const emptyView: DevflowView = {
  busy: false,
  note: null,
  error: null,
  project: 'demo-key',
  projects: [{ key: 'demo-key', name: 'demo', root: '/ws/demo', origin: 'workspace' }],
  ignoredRoots: [],
  waitingTotal: 0,
  items: [],
}

interface FakeRemoteHandle {
  remote: DevflowRemote
  count: () => number
}

/** Remote double recording every state call and answering a canned view. */
function fakeRemote(): FakeRemoteHandle {
  let calls = 0
  const remote = {
    state: (_request: { project: string | null }) => {
      calls++
      return Promise.resolve(ok(emptyView))
    },
  }
  return { remote: remote as unknown as DevflowRemote, count: () => calls }
}

describe('devflow ui poll cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls fast while open and slow once the page closes', async () => {
    const { remote, count } = fakeRemote()
    const store = new DevflowUiStore(remote)
    const unsubscribe = store.subscribe(() => undefined)
    try {
      // Subscription fires the immediate poll; the closed-page cadence is
      // the idle rate → exactly one call per 10s window. The 50ms settle
      // step lets the in-flight poll resolve so the guard admits the next.
      await vi.advanceTimersByTimeAsync(50)
      const beforeIdle = count()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(count() - beforeIdle).toBe(1)

      // Open the page: the cadence re-arms to 1.5s → 6-7 calls per 10s.
      store.open()
      const beforeOpen = count()
      await vi.advanceTimersByTimeAsync(10_000)
      const openCalls = count() - beforeOpen
      expect(openCalls).toBeGreaterThanOrEqual(6)
      expect(openCalls).toBeLessThanOrEqual(8)

      // Close again: back to the idle rate.
      store.close()
      const beforeClose = count()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(count() - beforeClose).toBe(1)
    } finally {
      unsubscribe()
      store.dispose()
    }
  })

  it('reverts to idle cadence when the last subscriber detaches and resubscribes', async () => {
    const { remote, count } = fakeRemote()
    const store = new DevflowUiStore(remote)
    const first = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(50)
    // Simulate the page closing before the badge unmounts.
    store.open()
    store.close()
    first()
    await vi.advanceTimersByTimeAsync(50)
    // Re-subscribe with the page closed → idle cadence from the start.
    const second = store.subscribe(() => undefined)
    try {
      // Settle the resubscription's immediate poll, then the closed-page
      // cadence is idle: exactly one call over the next 10s window.
      await vi.advanceTimersByTimeAsync(50)
      const before = count()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(count() - before).toBe(1)
    } finally {
      second()
      store.dispose()
    }
  })
})
