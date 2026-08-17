/**
 * Shared browser-side UI state for the devflow package: the generated Remote
 * namespace's type face, one polled {@link DevflowView} snapshot, and the
 * page open/close flag. The sidebar-foot trigger and the main-area page live
 * in two different slots (two registrations, no shared React state), so this
 * tiny store bridges them through useSyncExternalStore; polling runs only
 * while at least one component is subscribed.
 *
 * @module @deepseek-ai/dsh-devflow/client/ui
 */

import { useSyncExternalStore } from 'react'
import type {
  DevflowAnswer, DevflowDirListing, DevflowModelInfo, DevflowPickCapabilityResult,
  DevflowPromptsView, DevflowProjectAddResult, DevflowSettings, DevflowView,
} from '../types.ts'

/**
 * The result envelope every generated Remote method resolves with: a value,
 * or a structured failure. Carrier-level failures are folded into the error
 * branch by the Remote face itself.
 */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * Unwrap a Remote result envelope into its value; a failed call throws with
 * the failure's message so `.then(onOk, onError)` chains keep working.
 * @param result - the envelope a Remote method resolved with.
 * @returns the wrapped value.
 */
export function unwrapResult<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message === '' ? result.error.code : result.error.message)
}

/**
 * Await a Remote call and unwrap its envelope.
 * @param call - the promise a Remote method returned.
 * @returns the wrapped value.
 */
export async function callRemote<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  return unwrapResult(await call)
}

/** The generated devflow Remote namespace this UI consumes (type face only). */
export interface DevflowRemote {
  state(request: { project: string | null }): Promise<RemoteResult<DevflowView>>
  submit(request: {
    kind: 'requirement' | 'bug'
    text: string
    project: string | null
  }): Promise<RemoteResult<{ ok: boolean; id: string }>>
  answer(request: { itemId: string; stage: string | null; answers: DevflowAnswer[] }): Promise<RemoteResult<{ ok: boolean }>>
  cancel(request: { itemId: string }): Promise<RemoteResult<{ ok: boolean }>>
  resume(request: { itemId: string }): Promise<RemoteResult<{ ok: boolean }>>
  retry(request: { itemId: string }): Promise<RemoteResult<{ ok: boolean }>>
  artifact(request: { itemId: string; name: 'design' | 'plan' | 'report' | 'reviews' }): Promise<RemoteResult<string>>
  prompts(request: { project: string | null }): Promise<RemoteResult<DevflowPromptsView>>
  'prompt-set'(request: {
    stage: string
    template: string | null
    project: string | null
  }): Promise<RemoteResult<{ ok: boolean }>>
  'project-add'(request: { path: string }): Promise<RemoteResult<DevflowProjectAddResult>>
  'project-remove'(request: { key: string }): Promise<RemoteResult<{ ok: boolean; reason?: string }>>
  'project-scan'(request: { rescan: boolean }): Promise<RemoteResult<{ ok: boolean }>>
  'project-pick-capability'(): Promise<RemoteResult<DevflowPickCapabilityResult>>
  'project-pick-native'(): Promise<RemoteResult<{ path: string | null }>>
  'project-list-dir'(request: { path: string | null }): Promise<RemoteResult<DevflowDirListing>>
  'config.get'(request: { project: string | null }): Promise<RemoteResult<{ settings: DevflowSettings; warnings: readonly string[] }>>
  'config.set'(request: { project: string | null; settings: DevflowSettings }): Promise<RemoteResult<DevflowSettings>>
  'config.models'(request: { project: string | null }): Promise<RemoteResult<readonly DevflowModelInfo[]>>
}

/** Render an unknown error value as short text without String(anything). */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error)
}

/** Snapshot handed to React (one stable reference between emissions). */
export interface DevflowUiSnapshot {
  /** Whether the main-area devflow page is open. */
  readonly open: boolean
  /** Latest polled projection; null before the first response. */
  readonly view: DevflowView | null
  /** True when the last poll failed (the last good view is retained). */
  readonly offline: boolean
}

/**
 * Poll cadence while the main-area page is open: the workbench reads live
 * (item moving between stages, logs appending), so it needs the fast rate.
 */
const POLL_MS = 1500

/**
 * Poll cadence while only the sidebar trigger is mounted (page closed): the
 * badge just counts the waiting queue, where seconds of latency are
 * invisible — 10s keeps it fresh at ~1/7th the request volume.
 */
const POLL_IDLE_MS = 10_000

/**
 * Client UI store: open flag plus the polled panel projection of the active
 * project partition. Created once per client-plugin activation in apply()
 * and captured by both slot registrations — never a module-level singleton,
 * so a plugin reload drops the old timer with the old subscriptions instead
 * of leaking it.
 */
export class DevflowUiStore {
  readonly subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn)
    if (this.#listeners.size === 1) this.#startPolling()
    return () => {
      this.#listeners.delete(fn)
      if (this.#listeners.size === 0) this.#stopPolling()
    }
  }

  readonly getSnapshot = (): DevflowUiSnapshot => this.#snap

  #remote: DevflowRemote
  #listeners = new Set<() => void>()
  #snap: DevflowUiSnapshot = { open: false, view: null, offline: false }
  #timer: number | undefined
  #inFlight = false
  /** Active project key; null until the first response adopts the server default. */
  #projectKey: string | null = null

  /** @param remote - the generated Remote namespace captured from ctx. */
  constructor(remote: DevflowRemote) {
    this.#remote = remote
  }

  /** Open the main-area page. */
  open(): void {
    if (this.#snap.open) return
    this.#emit(true, this.#snap.view, this.#snap.offline)
    this.#applyCadence()
  }

  /** Close the main-area page. */
  close(): void {
    if (!this.#snap.open) return
    this.#emit(false, this.#snap.view, this.#snap.offline)
    this.#applyCadence()
  }

  /** Toggle the main-area page (the sidebar-foot trigger's click action). */
  toggle(): void {
    this.#emit(!this.#snap.open, this.#snap.view, this.#snap.offline)
    this.#applyCadence()
  }

  /**
   * Switch the polled project partition; a response still in flight for the
   * previous partition is dropped (and immediately re-polled) so the panel
   * never flashes the wrong project's pool.
   */
  setProject(key: string): void {
    if (this.#projectKey === key) return
    this.#projectKey = key
    this.refresh()
  }

  /** Ask for an immediate refresh on top of the cadence (after mutations). */
  refresh(): void {
    this.#poll()
  }

  /** Stop any timer (plugin dispose; subscriptions also wind down alone). */
  dispose(): void {
    this.#stopPolling()
    this.#listeners.clear()
  }

  #startPolling(): void {
    this.#poll()
    // Arm directly (NOT via #applyCadence — its un-armed guard is for the
    // open/close transitions and would wrongly no-op at subscription time,
    // leaving the store with no interval at all).
    this.#timer = setInterval(() => { this.#poll() }, this.#cadenceMs())
  }

  #stopPolling(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  /** (Re)arm the interval for the current cadence: fast while the page is
   * open, idle-slow while only the badge-bearing trigger is mounted. */
  #applyCadence(): void {
    if (this.#timer === undefined) return // nobody subscribed; nothing to arm
    this.#stopPolling()
    this.#timer = setInterval(() => { this.#poll() }, this.#cadenceMs())
  }

  #cadenceMs(): number {
    return this.#snap.open ? POLL_MS : POLL_IDLE_MS
  }

  #poll(): void {
    if (this.#inFlight) return
    this.#inFlight = true
    const requested = this.#projectKey
    callRemote(this.#remote.state({ project: requested })).then((view) => {
      this.#inFlight = false
      // A partition switch during the call makes this response stale.
      if (requested !== this.#projectKey) {
        this.#poll()
        return
      }
      // First load adopts the server's default partition so the switcher
      // and the store agree from the very first paint; a mismatch on a
      // later poll means the server fell back (the selected project was
      // removed) — adopt the fallback instead of erroring.
      if (view.project !== null) this.#projectKey = view.project
      this.#emit(this.#snap.open, view, false)
    }, (error: unknown) => {
      this.#inFlight = false
      if (requested !== this.#projectKey) {
        this.#poll()
        return
      }
      const fallback = this.#snap.view === null
        ? {
          busy: false,
          note: null,
          error: errorText(error),
          project: null,
          projects: [],
          ignoredRoots: [],
          waitingTotal: 0,
          items: [],
        }
        : this.#snap.view
      this.#emit(this.#snap.open, fallback, true)
    })
  }

  #emit(open: boolean, view: DevflowView | null, offline: boolean): void {
    this.#snap = { open, view, offline }
    for (const fn of this.#listeners) fn()
  }
}

/** React binding: subscribe the calling component to the store snapshot. */
export function useDevflowUi(store: DevflowUiStore): DevflowUiSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
