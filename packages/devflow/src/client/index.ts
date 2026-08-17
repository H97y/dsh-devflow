/**
 * Browser half of the devflow package. Two additive registrations, no
 * shipped surface replaced:
 *
 * - `sidebar.footer.action` — the entry button beside Settings at the
 *   sidebar foot (settings-trigger rhythm, rail circle when collapsed);
 * - `shell.overlay` — the main-area page, anchored to the sidebar's live
 *   right edge while open (renders null while closed).
 *
 * The plugin also mounts its own generated Remote contribution
 * (`@deepseek-ai/dsh-devflow/remote`) through the client Remote face, so the
 * `remote.devflow` namespace exists without any host-assembly wiring — the
 * published npm install path works unchanged. Both slot registrations share
 * one polled UI store (open flag + panel projection) created per activation,
 * so the trigger badge and the page never double-poll.
 *
 * @module @deepseek-ai/dsh-devflow/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution, TypertDisposer } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: brings the client Context's `slots` service face, the
// `shell.overlay` seat declaration (owned by ui-layout), and the
// `sidebar.footer.action` seat declaration (owned by ui-sidebar) into scope.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// This package's generated Remote contribution (an inline-safe wire artifact;
// the browser-bundle GENERATED_REMOTE rule exists for exactly this import).
import TYPERT_REMOTE from '@deepseek-ai/dsh-devflow/remote'
import { DevflowUiStore } from './devflow-ui.ts'
import type { DevflowRemote } from './devflow-ui.ts'
import { renderTrigger } from './trigger.tsx'
import { renderPage } from './page.tsx'

/** Stable Cordis plugin name. */
export const name = 'devflow-panel'

/** The slot registry and the client Remote carrier. */
export const inject = ['slots', 'remote']

/**
 * The client Remote face slice this plugin calls (the full face lives behind
 * the api-gateway assembly; only the mount operation is needed here).
 */
interface RemoteMountFace {
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
}

/**
 * The sessions-service slice this plugin calls: switching the main
 * conversation onto a pump agent's session. Optional at runtime — a host
 * without the service simply hides the jump affordance.
 */
interface SessionsOpenFace {
  open(id: string): void
}

/**
 * Mount this package's Remote namespace, then register the sidebar-foot
 * trigger and the main-area page.
 * @param ctx - client Cordis context.
 */
export async function apply(ctx: Context): Promise<void> {
  const disposeRemote
    = await (ctx as unknown as { remote: RemoteMountFace }).remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => disposeRemote, 'devflow.remote mount')
  const remote = ctx.get('remote.devflow') as DevflowRemote | undefined
  if (remote === undefined) {
    throw new Error('devflow: remote namespace missing after $mount')
  }
  const store = new DevflowUiStore(remote)
  ctx.effect(() => () => { store.dispose() }, 'devflow.ui store')
  // Session jump for pump agents: close the full-area overlay first so the
  // conversation it hands over to is actually visible, then select the child
  // session. `open` fails loud on unknown ids — a run settling between poll
  // and click is a normal race, so it degrades to a silent no-op.
  const sessions = ctx.get('sessions') as SessionsOpenFace | undefined
  const openSession = sessions === undefined
    ? undefined
    : (id: string): void => {
      store.close()
      try {
        sessions.open(id)
      } catch {
        // settled/removed meanwhile; the next poll drops the affordance
      }
    }
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'devflow-trigger', order: 10, label: '自动开发流水线' },
    (props: { wide: boolean }) => renderTrigger(store, props.wide),
  )), 'devflow.trigger')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'devflow-page', order: 80, label: '自动开发流水线' },
    () => renderPage(store, remote, openSession),
  )), 'devflow.page')
}
