/**
 * The devflow settings dialog: opened by the gear at the right end of the
 * sidebar-foot「开发流水线」row, and the single home for the plugin's global
 * configuration. Mirrors the harness settings shell geometry (800px centered
 * panel, 188px left nav rail, 54px content header, scrolling options area):
 * the left nav switches sections, the right column shows the section body.
 * Two sections — 阶段模型 / 自动泵 (per-stage model routing plus the
 * host-spawned auto-pump toggle) and 阶段提示词 (stage prompt template
 * overrides), both moved out of the workbench header. Section bodies read
 * row styles from page.module.css (the shared style bank); this module owns
 * the dialog chrome.
 *
 * @module @deepseek-ai/dsh-devflow/client/settings
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, IconCloseOutline16, IconDataOutline16, IconEditOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DevflowModelInfo, DevflowPromptsView, DevflowPumpView, DevflowSettings,
  DevflowSettingsView,
} from '../types.ts'
import type { DevflowRemote } from './devflow-ui.ts'
import { callRemote, errorText } from './devflow-ui.ts'
import { STAGE_IDS, STAGE_LABELS } from '../config/schema.ts'
import pageCss from './page.module.css'
import css from './settings.module.css'

/** Chinese labels for the editable prompt stages. */
const PROMPT_STAGE: Record<string, string> = {
  system: '系统提示词',
  refine: '需求精炼',
  design: '设计',
  plan: '计划',
  reviewDp: '评审·设计计划',
  fixDesign: '修订设计',
  fixPlan: '修订计划',
  codeReview: '代码评审',
  report: '开发报告',
}

/** Stage models + auto-pump section (per current project partition). */
function ModelsSection({ remote, project, pumpStatus }: {
  remote: DevflowRemote
  project: string | null
  /** Live auto-pump projection from the polled view (status line only). */
  pumpStatus: DevflowPumpView | null
}): JSX.Element {
  const [settings, setSettings] = useState<DevflowSettings | null>(null)
  const [warnings, setWarnings] = useState<readonly string[]>([])
  const [models, setModels] = useState<readonly DevflowModelInfo[] | null>(null)
  const [modelsError, setModelsError] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [pumpOn, setPumpOn] = useState(false)
  const [pumpModel, setPumpModel] = useState('')

  useEffect(() => {
    let cancelled = false
    setSettings(null)
    setModels(null)
    setModelsError('')
    setStatus('')
    callRemote(remote['config.get']({ project })).then((view: DevflowSettingsView) => {
      if (cancelled) return
      setSettings(view.settings)
      setWarnings(view.warnings)
      setDraft({ ...view.settings.stageModels })
      setPumpOn(view.settings.pump?.enabled === true)
      setPumpModel(view.settings.pump?.model ?? '')
    }, (error: unknown) => {
      if (!cancelled) setStatus(`加载失败: ${errorText(error)}`)
    }).catch(() => undefined)
    callRemote(remote['config.models']({ project })).then((list: readonly DevflowModelInfo[]) => {
      if (cancelled) return
      setModels(list)
    }, (error: unknown) => {
      if (!cancelled) setModelsError(errorText(error))
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [remote, project])

  const save = useCallback(() => {
    if (settings === null) return
    setSaving(true)
    setStatus('保存中…')
    const next: DevflowSettings = {
      version: 1,
      stageModels: Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== '')),
      pump: { enabled: pumpOn, model: pumpModel },
    }
    callRemote(remote['config.set']({ project, settings: next })).then((saved: DevflowSettings) => {
      setSaving(false)
      setSettings(saved)
      setDraft({ ...saved.stageModels })
      setPumpOn(saved.pump?.enabled === true)
      setPumpModel(saved.pump?.model ?? '')
      setWarnings([])
      setStatus('已保存 ✓ 即时生效')
    }, (error: unknown) => {
      setSaving(false)
      setStatus(`保存失败: ${errorText(error)}`)
    }).catch(() => undefined)
  }, [remote, project, settings, draft, pumpOn, pumpModel])

  // Three-state degradation (D21): empty catalog, call failure, and drift
  // are distinct conditions and must not be conflated.
  const catalogEmpty = models !== null && models.length === 0
  const knownIds = new Set(models?.map(m => m.id) ?? [])
  const stale = (id: string): boolean => models !== null && models.length > 0 && id !== '' && !knownIds.has(id)

  return (
    <div>
      {warnings.map((warning, index) => (
        <div key={index} className={pageCss.errorText}>{`⚠ ${warning}`}</div>
      ))}
      <div className={pageCss.muted}>
        未配置的阶段使用 harness 当前模型；候选只读自 harness 已配置模型。
      </div>
      {modelsError !== ''
        ? <div className={pageCss.errorText}>{`⚠ 模型列表加载失败: ${modelsError}`}</div>
        : null}
      {catalogEmpty
        ? <div className={pageCss.muted}>harness 暂无已配置模型，暂不能选择阶段模型（不影响回退运行）。</div>
        : null}
      {STAGE_IDS.map(stage => (
        <div key={stage} className={pageCss.settingsRow}>
          <label className={pageCss.settingsLabel}>{STAGE_LABELS[stage]}</label>
          <select
            className={pageCss.select}
            value={draft[stage] ?? ''}
            onChange={(event) => { setDraft({ ...draft, [stage]: event.target.value }) }}
          >
            <option value="">（回退 harness 当前模型）</option>
            {(models ?? []).map(model => (
              <option key={model.id} value={model.id}>{model.label}</option>
            ))}
          </select>
          {stale(draft[stage] ?? '')
            ? <span className={pageCss.errorText}>已漂移，将回退当前模型</span>
            : null}
        </div>
      ))}
      <div className={pageCss.sectionTitle}>自动泵（工具阶段无人值守执行）</div>
      {pumpStatus !== null && !pumpStatus.available
        ? <div className={pageCss.errorText}>⚠ 宿主未组装 agents 服务，自动泵不可用（实施/修复/验证/合并仍可手动泵）。</div>
        : null}
      <div className={pageCss.muted}>
        开启后，实施 / 修复 / Web 验证 / 合并阶段由插件直接派出的独立 agent 会话执行，无需专门挂一个泵会话；
        agent 需要拍板时会在该会话里提问并等待你的答复（面板与侧栏均会亮起待答标记）。
        {pumpStatus !== null
          ? `当前：${pumpStatus.activeCount}/${pumpStatus.maxConcurrent} 个代理运行中（并发上限为部署配置）。`
          : ''}
      </div>
      <div className={pageCss.settingsRow}>
        <label className={pageCss.settingsLabel}>自动泵</label>
        <Button
          variant={pumpOn ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => { setPumpOn(!pumpOn) }}
        >
          {pumpOn ? '已开启' : '已关闭'}
        </Button>
        <span className={pageCss.muted}>关闭后进行中的任务会跑完，不再派新代理。</span>
      </div>
      <div className={pageCss.settingsRow}>
        <label className={pageCss.settingsLabel}>泵代理模型</label>
        <select
          className={pageCss.select}
          value={pumpModel}
          onChange={(event) => { setPumpModel(event.target.value) }}
        >
          <option value="">（跟随 harness 当前模型）</option>
          {(models ?? []).map(model => (
            <option key={model.id} value={model.id}>{model.label}</option>
          ))}
        </select>
        {stale(pumpModel)
          ? <span className={pageCss.errorText}>已漂移，将回退当前模型</span>
          : null}
      </div>
      <div className={pageCss.actions}>
        <Button variant="primary" size="sm" disabled={saving || settings === null} onClick={() => { save() }}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
      {status !== '' ? <div className={pageCss.muted}>{status}</div> : null}
    </div>
  )
}

/** Stage prompt template section: pick, edit, save, reset. */
function PromptsSection({ remote, project }: {
  remote: DevflowRemote
  project: string | null
}): JSX.Element {
  const [data, setData] = useState<DevflowPromptsView | null>(null)
  const [stage, setStage] = useState('design')
  const [text, setText] = useState('')
  const [status, setStatus] = useState('')
  useEffect(() => {
    let cancelled = false
    callRemote(remote.prompts({ project })).then((view) => {
      if (cancelled) return
      setData(view)
      setText(view.custom.design ?? view.defaults.design ?? '')
    }, (error: unknown) => {
      if (!cancelled) setStatus(`加载失败: ${errorText(error)}`)
    })
    return () => {
      cancelled = true
    }
  }, [remote, project])
  const pick = (next: string): void => {
    setStage(next)
    setText(data === null ? '' : data.custom[next] ?? data.defaults[next] ?? '')
    setStatus('')
  }
  const save = useCallback(() => {
    setStatus('保存中…')
    callRemote(remote['prompt-set']({ stage, template: text, project })).then(() => callRemote(remote.prompts({ project })).then((view) => {
      setData(view)
      setStatus(text === view.defaults[stage] ? '已保存（与默认一致）' : '已保存 ✓')
    }), (error: unknown) => {
      setStatus(`保存失败: ${errorText(error)}`)
    }).catch((error: unknown) => {
      setStatus(`保存失败: ${errorText(error)}`)
    })
  }, [remote, stage, text, project])
  const reset = useCallback(() => {
    setStatus('恢复中…')
    callRemote(remote['prompt-set']({ stage, template: null, project })).then(() => callRemote(remote.prompts({ project })).then((view) => {
      setData(view)
      setText(view.defaults[stage] ?? '')
      setStatus('已恢复默认 ✓')
    }), (error: unknown) => {
      setStatus(`恢复失败: ${errorText(error)}`)
    }).catch((error: unknown) => {
      setStatus(`恢复失败: ${errorText(error)}`)
    })
  }, [remote, stage, project])
  if (data === null) {
    return <div className={pageCss.muted}>{status === '' ? '加载提示词…' : status}</div>
  }
  const vars = data.vars[stage] ?? []
  const customized = data.custom[stage] !== undefined
  return (
    <div>
      <div className={pageCss.actions}>
        <select className={pageCss.select} value={stage} onChange={(event) => { pick(event.target.value) }}>
          {Object.keys(PROMPT_STAGE).map(key => (
            <option key={key} value={key}>{`${PROMPT_STAGE[key] ?? key}${data.custom[key] !== undefined ? '（已自定义）' : ''}`}</option>
          ))}
        </select>
        <span className={customized ? pageCss.customized : pageCss.muted}>{customized ? '已自定义' : '默认'}</span>
        <Button variant="primary" size="sm" onClick={() => { save() }}>保存</Button>
        <Button variant="ghost" size="sm" onClick={() => { reset() }}>恢复默认</Button>
      </div>
      <div className={pageCss.muted}>
        {vars.length > 0 ? `可用变量: ${vars.map(v => `{{${v}}}`).join('  ')}` : '（无变量，纯文本）'}
      </div>
      <textarea className={`${pageCss.area} ${pageCss.editorArea}`} value={text} onChange={(event) => { setText(event.target.value) }} />
      {status !== '' ? <div className={pageCss.muted}>{status}</div> : null}
    </div>
  )
}

/** Nav row descriptor: id + label + glyph. */
const SECTIONS = [
  { id: 'models', label: '阶段模型 / 自动泵', icon: <IconDataOutline16 size={16} /> },
  { id: 'prompts', label: '阶段提示词', icon: <IconEditOutline16 size={16} /> },
] as const

type SectionId = typeof SECTIONS[number]['id']

/**
 * The devflow settings dialog shell. Portals to the document body so the
 * sidebar's stacking contexts cannot clip it; Escape, mask click, and the
 * header button all close.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - close request (Escape / mask / header button).
 * @param props.remote - the generated Remote namespace.
 * @param props.project - the project partition the sections configure.
 * @param props.pumpStatus - live auto-pump projection (status line only).
 * @returns null while closed; otherwise the portaled overlay tree.
 */
export function DevflowSettingsModal({ open, onClose, remote, project, pumpStatus }: {
  open: boolean
  onClose: () => void
  remote: DevflowRemote
  project: string | null
  pumpStatus: DevflowPumpView | null
}): JSX.Element | null {
  const [section, setSection] = useState<SectionId>('models')

  // Document-level Escape while open only; the workbench page yields its own
  // Escape handling while the owning trigger reports the dialog to the store.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (open) closeButton.current?.focus()
  }, [open])

  if (!open) return null

  // No portal: the fixed overlay renders as a descendant of the sidebar
  // column — the same posture as the harness's own settings panel (the
  // shell keeps no persistent transform on the column, so fixed geometry
  // holds; the ui-settings panel mounts the same way).
  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-label="流水线设置">
        <nav className={css.nav}>
          <div className={css.navTitle}>流水线设置</div>
          <div className={css.navList}>
            {SECTIONS.map(entry => (
              <button
                key={entry.id}
                type="button"
                className={`${css.navCell}${section === entry.id ? ` ${css.active}` : ''}`}
                aria-current={section === entry.id ? 'true' : undefined}
                onClick={() => { setSection(entry.id) }}
              >
                {entry.icon}
                <span className={css.navLabel}>{entry.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions} />
            <button
              ref={closeButton}
              type="button"
              className={css.close}
              aria-label="关闭"
              onClick={onClose}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <div className={css.options}>
            {section === 'models'
              ? <ModelsSection remote={remote} project={project} pumpStatus={pumpStatus} />
              : <PromptsSection remote={remote} project={project} />}
          </div>
        </div>
      </div>
    </div>
  )
}
