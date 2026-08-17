/**
 * The devflow entry at the sidebar foot, beside Settings. The wide row is a
 * two-cell group: the main cell (icon + label + waiting-count pill) is a
 * menu trigger — clicking it expands the project submenu, a portal-anchored
 * Menu (the sidebar column clips in-place lists) listing every project
 * partition with the workspace picker's folder-row rhythm (trailing check
 * on the polled partition) — and the row's right end carries a gear icon
 * button opening the pipeline settings dialog (nav + detail, harness
 * settings-shell rhythm). Picking a project switches the partition and
 * opens the workbench; the pinned「添加项目」footer row raises the
 * project-manage dialog straight from the sidebar. The rail state keeps
 * the single circle as the menu trigger (no room for the gear at 36px —
 * expanding the sidebar brings it back).
 *
 * @module @deepseek-ai/dsh-devflow/client/trigger
 */

import type { JSX } from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  IconChecklistOutline14, IconFolderClose16, IconProjectAddOutline16,
  IconSettingsOutline16, Menu, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DevflowRemote, DevflowUiStore } from './devflow-ui.ts'
import { ProjectManageModal } from './page.tsx'
import { DevflowSettingsModal } from './settings.tsx'
import css from './trigger.module.css'

/** Trigger copy (the rail tooltip and the wide row label). */
const LABEL = '开发流水线'

/** Submenu sentinel id for the pinned add-project footer row. */
const ADD_PROJECT = '::add-project'

/**
 * Render the sidebar-foot trigger with its project submenu, gear button,
 * and the two dialogs they raise.
 * @param props.store - the shared UI store (open/menu/modal flags + polled view).
 * @param props.remote - the generated Remote namespace (dialog calls).
 * @param props.wide - whether the sidebar renders wide content (false = rail).
 * @returns the trigger element tree.
 */
export function DevflowTrigger({ store, remote, wide }: {
  store: DevflowUiStore
  remote: DevflowRemote
  wide: boolean
}): JSX.Element {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [manageOpen, setManageOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null)
  // waitingTotal aggregates the waiting queue across every project partition,
  // so the badge stays honest no matter which partition the panel polls.
  const waiting = snap.view?.waitingTotal ?? 0
  const badge = waiting > 0
    ? <span className={wide ? css.badge : css.railBadge}>{waiting > 9 ? '9+' : String(waiting)}</span>
    : null

  // One modal at a time; either being open tells the store so the workbench
  // page yields its Escape handling to the dialog.
  useEffect(() => {
    if (manageOpen || settingsOpen) store.openModal()
    else store.closeModal()
  }, [manageOpen, settingsOpen, store])

  const projects = snap.view?.projects ?? []
  const items: MenuEntry[] = [
    { type: 'label', id: 'projects-label', text: '项目' },
    ...projects.map((project): MenuEntry => ({
      id: project.key,
      label: project.name,
      icon: <IconFolderClose16 size={16} />,
    })),
  ]
  if (projects.length === 0) {
    items.push({ type: 'label', id: 'projects-empty', text: '暂无项目，可用下方「添加项目」接入' })
  }
  // The add row rides the Menu's pinned footer (always visible under a
  // scrolling project list), mirroring the workspace picker's add entry.
  const footer: MenuEntry[] = [{
    id: ADD_PROJECT,
    label: '添加项目',
    icon: <IconProjectAddOutline16 size={16} />,
  }]

  const handleSelect = (id: string): void => {
    store.closeMenu()
    if (id === ADD_PROJECT) {
      setManageOpen(true)
      return
    }
    // A project row: switch the polled partition and land in that project's
    // workbench (clicking the checked row simply opens the page).
    store.setProject(id)
    store.open()
  }

  const mainCell = (
    <Tooltip label={LABEL} delayMs={500} disabled={wide}>
      <button
        ref={setTriggerEl}
        type="button"
        className={`${wide ? css.trigger : css.rail}${snap.open || snap.menuOpen ? ` ${css.active}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={snap.menuOpen}
        aria-label={LABEL}
        onClick={() => {
          // Opening the submenu refreshes the directory so freshly
          // added or auto-discovered projects are listed without
          // waiting out the idle poll cadence.
          if (!snap.menuOpen) store.refresh()
          store.toggleMenu()
        }}
      >
        <IconChecklistOutline14 size={wide ? 16 : 18} />
        {wide && <span className={css.label}>{LABEL}</span>}
        {badge}
      </button>
    </Tooltip>
  )

  // Wide: the row is a segmented group — menu cell plus the gear cell at the
  // right end (the Menu's anchor wraps the whole group, but the portaled
  // list positions from the menu cell's own rect). Rail: the circle alone
  // (no room for the gear at 36px; expanding the sidebar brings it back).
  const anchor = wide
    ? (
      <div className={css.row}>
        {mainCell}
        <Tooltip label="流水线设置" side="top" delayMs={500}>
          <button
            type="button"
            className={css.gear}
            aria-label="流水线设置"
            aria-haspopup="dialog"
            onClick={() => {
              store.closeMenu()
              setSettingsOpen(true)
            }}
          >
            <IconSettingsOutline16 size={14} />
          </button>
        </Tooltip>
      </div>
    )
    : mainCell

  return (
    <>
      <Menu
        className={css.menuRoot}
        open={snap.menuOpen}
        anchor={anchor}
        items={items}
        footer={footer}
        selectedId={snap.view?.project ?? undefined}
        onSelect={handleSelect}
        onClose={() => { store.closeMenu() }}
        side="top"
        portal
        getAnchorRect={() => triggerEl?.getBoundingClientRect() ?? null}
      />
      <ProjectManageModal
        open={manageOpen}
        onClose={() => { setManageOpen(false) }}
        remote={remote}
        store={store}
        view={snap.view}
      />
      <DevflowSettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false) }}
        remote={remote}
        project={snap.view?.project ?? null}
        pumpStatus={snap.view?.pump ?? null}
      />
    </>
  )
}

/** Element factory for the .ts registration entry (no JSX at that side). */
export function renderTrigger(store: DevflowUiStore, remote: DevflowRemote, wide: boolean): JSX.Element {
  return <DevflowTrigger store={store} remote={remote} wide={wide} />
}
