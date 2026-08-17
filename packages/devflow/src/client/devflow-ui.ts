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
  DevflowAnswer, DevflowPromptsView, DevflowView,
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
  state(): Promise<RemoteResult<DevflowView>>
  submit(request: { kind: 'requirement' | 'bug'; text: string }): Promise<RemoteResult<{ ok: boolean; id: string }>>
  answer(request: { itemId: string; stage: string | null; answers: DevflowAnswer[] }): Promise<RemoteResult<{ ok: boolean }>>
  cancel(request: { itemId: string }): Promise<RemoteResult<{ ok: boolean }>>
  resume(request: { itemId: string }): Promise<RemoteResult<{ ok: boolean }>>
  retry(request: { itemId: string }): Promise<RemoteResult<{ ok: boolean }>>
  artifact(request: { itemId: string; name: 'design' | 'plan' | 'report' | 'reviews' }): Promise<RemoteResult<string>>
  prompts(): Promise<RemoteResult<DevflowPromptsView>>
  'prompt-set'(request: { stage: string; template: string | null }): Promise<RemoteResult<{ ok: boolean }>>
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

/** Poll cadence; the panel already refreshed at this rate. */
const POLL_MS = 1500

/**
 * Client UI store: open flag plus the polled panel projection. Created once
 * per client-plugin activation in apply() and captured by both slot
 * registrations — never a module-level singleton, so a plugin reload drops
 * the old timer with the old subscriptions instead of leaking it.
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

  /** @param remote - the generated Remote namespace captured from ctx. */
  constructor(remote: DevflowRemote) {
    this.#remote = remote
  }

  /** Open the main-area page. */
  open(): void {
    if (this.#snap.open) return
    this.#emit(true, this.#snap.view, this.#snap.offline)
  }

  /** Close the main-area page. */
  close(): void {
    if (!this.#snap.open) return
    this.#emit(false, this.#snap.view, this.#snap.offline)
  }

  /** Toggle the main-area page (the sidebar-foot trigger's click action). */
  toggle(): void {
    this.#emit(!this.#snap.open, this.#snap.view, this.#snap.offline)
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
    this.#timer = window.setInterval(() => { this.#poll() }, POLL_MS)
  }

  #stopPolling(): void {
    if (this.#timer !== undefined) {
      window.clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  #poll(): void {
    if (this.#inFlight) return
    this.#inFlight = true
    callRemote(this.#remote.state()).then((view) => {
      this.#inFlight = false
      this.#emit(this.#snap.open, view, false)
    }, (error: unknown) => {
      this.#inFlight = false
      const fallback = this.#snap.view === null
        ? { busy: false, note: null, error: errorText(error), items: [] }
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
