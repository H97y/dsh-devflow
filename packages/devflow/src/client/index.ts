/**
 * Browser half of the devflow package: mounts the control panel into the
 * frame-wide `shell.overlay` list slot (additive, click-through until this
 * entry opts into pointer events through its own fixed positioning).
 *
 * @module @deepseek-ai/dsh-devflow/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: brings the client Context's `slots` service face and the
// `shell.overlay` seat declaration (owned by ui-layout) into scope.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { renderPanel } from './panel.tsx'
import type { DevflowRemote } from './panel.tsx'

/** Stable Cordis plugin name. */
export const name = 'devflow-panel'

/** The slot registry, the Remote carrier, and this package's namespace. */
export const inject = ['slots', 'remote', 'remote.devflow']

/**
 * Register the panel entry in the shell overlay.
 * @param ctx - client Cordis context.
 */
export function apply(ctx: Context): void {
  // The generated namespace's typed face lives behind the api-remotes
  // assembly; this package names only the slice it calls.
  const remote = (ctx as unknown as { remote: { devflow: DevflowRemote } }).remote.devflow
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'devflow-panel', order: 80, label: '自动开发流水线' },
    () => renderPanel(remote),
  )), 'devflow.panel')
}
