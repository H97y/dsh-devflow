/**
 * The devflow entry at the sidebar foot, beside Settings. Geometry and hover
 * chrome mirror the settings trigger row (34px compact row in the wide
 * column; 36px circle on the rail) so the two read as one native group. The
 * row carries a small count pill for items waiting on a human decision, and
 * stays visually active while the devflow page is open.
 *
 * @module @deepseek-ai/dsh-devflow/client/trigger
 */

import type { JSX } from 'react'
import { useSyncExternalStore } from 'react'
import { IconChecklistOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DevflowItemView } from '../types.ts'
import type { DevflowUiStore } from './devflow-ui.ts'
import css from './trigger.module.css'

/** Trigger copy (the rail tooltip and the wide row label). */
const LABEL = '开发流水线'

/** Items parked in the waiting queue: a human decision is pending. */
function waitingCount(items: readonly DevflowItemView[]): number {
  return items.filter(i => i.questions !== null && i.status !== 'active' && i.status !== 'paused').length
}

/**
 * Render the sidebar-foot trigger button.
 * @param props.store - the shared UI store (open flag + polled counts).
 * @param props.wide - whether the sidebar renders wide content (false = rail).
 * @returns the trigger element tree.
 */
export function DevflowTrigger({ store, wide }: { store: DevflowUiStore; wide: boolean }): JSX.Element {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const waiting = snap.view === null ? 0 : waitingCount(snap.view.items)
  const badge = waiting > 0
    ? <span className={wide ? css.badge : css.railBadge}>{waiting > 9 ? '9+' : String(waiting)}</span>
    : null
  return (
    <Tooltip label={LABEL} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={`${wide ? css.trigger : css.rail}${snap.open ? ` ${css.active}` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={snap.open}
        aria-label={LABEL}
        onClick={() => { store.toggle() }}
      >
        <IconChecklistOutline14 size={wide ? 16 : 18} />
        {wide && <span className={css.label}>{LABEL}</span>}
        {badge}
      </button>
    </Tooltip>
  )
}

/** Element factory for the .ts registration entry (no JSX at that side). */
export function renderTrigger(store: DevflowUiStore, wide: boolean): JSX.Element {
  return <DevflowTrigger store={store} wide={wide} />
}
