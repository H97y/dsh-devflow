/**
 * The devflow page: a main-area surface that opens to the right of the
 * sidebar (anchored to its live edge) instead of the old bottom-right
 * floating popup. Master-detail on the wide canvas — the left column holds
 * the requirement-pool entry plus the grouped pipeline sections, the right
 * pane shows the selected item's detail, a read-only artifact, or the stage
 * prompt editor. State arrives through the shared polled store; every
 * mutation is a plain Remote call followed by an immediate refresh.
 *
 * @module @deepseek-ai/dsh-devflow/client/page
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, IconChevronLeftOutline14, IconCloseOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DevflowAnswer, DevflowItemView, DevflowPromptsView, DevflowQuestion,
} from '../types.ts'
import type { DevflowRemote, DevflowUiStore, RemoteResult } from './devflow-ui.ts'
import { callRemote, errorText, useDevflowUi } from './devflow-ui.ts'
import css from './page.module.css'

/** Sidebar fallback when the live edge cannot be measured (SIDEBAR_DEFAULT). */
const DEFAULT_LEFT_PX = 280

/** Chinese labels for item statuses. */
const STATUS: Record<string, string> = {
  raw: '待精炼',
  refining: '精炼中',
  'needs-user': '待补充',
  ready: '就绪',
  active: '流水线中',
  done: '已完成',
  rejected: '搁置',
  paused: '已暂停',
}

/** Chinese labels for pipeline stages. */
const STAGE: Record<string, string> = {
  design: '设计',
  plan: '计划',
  'review-dp': '评审·设计计划',
  implement: '实施',
  'code-review': '评审·代码',
  'fix-code': '修复代码',
  verify: 'Web验证',
  merge: '合并回main',
  report: '生成报告',
}

/** Chinese labels for implementation sizes. */
const SIZE: Record<string, string> = { small: '小', medium: '中', large: '大' }

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

/** Badge tone → css class (kept explicit so every tone is checked here). */
const TONE = {
  neutral: css.toneNeutral,
  accent: css.toneAccent,
  bug: css.toneBug,
  wait: css.toneWait,
  ok: css.toneOk,
  muted: css.toneMuted,
  error: css.toneError,
} as const

/** One badge chip. */
function Badge({ tone = 'neutral', children }: {
  tone?: keyof typeof TONE
  children: string
}): JSX.Element {
  return <span className={`${css.badge} ${TONE[tone]}`}>{children}</span>
}

/** The full badge set for one item (kind, status, stage, workspace, …). */
function itemBadges(item: DevflowItemView): JSX.Element[] {
  const badges: JSX.Element[] = [
    <Badge key="kind" tone={item.kind === 'bug' ? 'bug' : 'accent'}>
      {item.kind === 'bug' ? 'bug' : '需求'}
    </Badge>,
    <Badge key="status">{STATUS[item.status] ?? item.status}</Badge>,
  ]
  if (item.size !== null) badges.push(<Badge key="size">{SIZE[item.size] ?? item.size}</Badge>)
  if (item.score !== null) {
    badges.push(<Badge key="score" tone="muted">{`价值${item.score.value}·完整${item.score.completeness}`}</Badge>)
  }
  if (item.status === 'active' && item.stage !== null) {
    badges.push(<Badge key="stage" tone="accent">{STAGE[item.stage] ?? item.stage}</Badge>)
  }
  if (item.status === 'active' && item.round > 0) {
    badges.push(<Badge key="round" tone="muted">{`第${item.round}轮`}</Badge>)
  }
  if (item.workspaceKind !== null) {
    badges.push(
      <Badge key="ws" tone="muted">
        {item.workspaceKind === 'main' ? '主工作区' : `worktree ${item.workspaceBranch ?? ''}`}
      </Badge>,
    )
  }
  if (item.running) {
    badges.push(<Badge key="run" tone="ok">{`执行中${item.note === null ? '' : `·${item.note}`}`}</Badge>)
  } else if (item.note !== null) {
    badges.push(<Badge key="note" tone="wait">{`暂停·${item.note}`}</Badge>)
  }
  if (item.resourceWaiting !== null) {
    badges.push(
      <Badge key="rw" tone="wait">
        {item.resourceWaiting === 'workspace' ? '等待主工作区' : '等待worktree'}
      </Badge>,
    )
  }
  if (item.status === 'paused' && item.stage !== null) {
    badges.push(<Badge key="bp" tone="muted">{`断点·${STAGE[item.stage] ?? item.stage}`}</Badge>)
  }
  if (item.questions !== null) {
    const where = item.waitingStage === null ? '需求补充' : STAGE[item.waitingStage] ?? item.waitingStage
    badges.push(<Badge key="q" tone="wait">{`待决策·${where}`}</Badge>)
  }
  if (item.status === 'done') badges.push(<Badge key="done" tone="ok">已交付</Badge>)
  if (item.status === 'rejected') {
    badges.push(<Badge key="rej" tone="muted">{item.rejectReason === '' ? '搁置' : item.rejectReason}</Badge>)
  }
  return badges
}

/** One waiting question with option chips and a free-text supplement. */
function Questions({ item, onAnswer }: {
  item: DevflowItemView
  onAnswer: (itemId: string, stage: string | null, answers: DevflowAnswer[]) => Promise<void>
}): JSX.Element {
  const questions = item.questions ?? []
  const keyOf = (question: DevflowQuestion): string =>
    `${item.id}|${item.waitingStage ?? 'pool'}|${question.id ?? question.q}`
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const submit = useCallback(() => {
    const answers: DevflowAnswer[] = []
    for (const question of questions) {
      const key = keyOf(question)
      const picked = selected[key] ?? ''
      const note = notes[key] ?? ''
      const combined = picked + (note === '' ? '' : `${picked === '' ? '' : '；'}${note}`)
      if (combined !== '') answers.push({ q: question.q, a: combined })
    }
    if (answers.length === 0) return
    setSending(true)
    onAnswer(item.id, item.waitingStage, answers).catch(() => undefined).finally(() => {
      setSending(false)
    })
  }, [questions, selected, notes, item.id, item.waitingStage, onAnswer])
  return (
    <div className={css.questions}>
      <div className={css.questionsTitle}>需要你决策或补充</div>
      {questions.map((question, index) => (
        <div key={index} className={css.questionBlock}>
          <div className={css.question}>{`${question.recommend !== undefined ? '推荐 ' : ''}${question.q}`}</div>
          <div className={css.options}>
            {question.options.map((option, optionIndex) => {
              const key = keyOf(question)
              const on = selected[key] === option.label
              return (
                <button
                  key={optionIndex}
                  type="button"
                  title={option.desc === '' ? undefined : option.desc}
                  className={`${css.option}${on ? ` ${css.optionOn}` : ''}`}
                  onClick={() => { setSelected({ ...selected, [key]: option.label }) }}
                >
                  {`${option.label}${question.recommend === option.label ? ' ✓' : ''}`}
                </button>
              )
            })}
          </div>
          <textarea
            className={`${css.area} ${css.areaSmall}`}
            placeholder="补充说明（可选）"
            value={notes[keyOf(question)] ?? ''}
            onChange={(event) => { setNotes({ ...notes, [keyOf(question)]: event.target.value }) }}
          />
        </div>
      ))}
      <div className={css.actions}>
        <Button variant="primary" size="sm" disabled={sending} onClick={submit}>提交答复</Button>
      </div>
    </div>
  )
}

/** The selected item's full detail (right pane's default mode). */
function ItemDetail({ item, remote, store, onArtifact }: {
  item: DevflowItemView
  remote: DevflowRemote
  store: DevflowUiStore
  onArtifact: (itemId: string, name: 'design' | 'plan' | 'report' | 'reviews') => void
}): JSX.Element {
  const [showLog, setShowLog] = useState(false)
  const call = useCallback((action: Promise<RemoteResult<unknown>>): void => {
    callRemote(action).then(() => { store.refresh() }, () => undefined).catch(() => undefined)
  }, [store])
  return (
    <div className={css.detailBody}>
      <div className={css.detailTitle}>{item.title}</div>
      <div className={css.badges}>{itemBadges(item)}</div>
      <div className={css.preview}>{item.preview}</div>
      {item.questions !== null && item.status !== 'paused'
        ? <Questions item={item} onAnswer={async (itemId, stage, answers) => { call(remote.answer({ itemId, stage, answers })) }} />
        : null}
      {item.error !== null
        ? (
          <div className={css.errorRow}>
            <span className={css.errorText}>{`⚠ ${item.error}`}</span>
            <Button variant="ghost" size="sm" onClick={() => { call(remote.retry({ itemId: item.id })) }}>重试</Button>
          </div>
        )
        : null}
      {item.status === 'active' || item.status === 'refining' || item.status === 'needs-user'
        ? (
          <div className={css.actions}>
            <Button variant="ghost" size="sm" onClick={() => { call(remote.cancel({ itemId: item.id })) }}>
              {item.status === 'needs-user' ? '暂停并收起问题' : '中断'}
            </Button>
          </div>
        )
        : null}
      {item.status === 'paused'
        ? (
          <div className={css.actions}>
            <Button variant="primary" size="sm" onClick={() => { call(remote.resume({ itemId: item.id })) }}>继续</Button>
            {item.questions !== null
              ? (
                <Button variant="ghost" size="sm" onClick={() => { call(remote.resume({ itemId: item.id })) }}>
                  重新回答问题
                </Button>
              )
              : null}
          </div>
        )
        : null}
      {(item.status === 'active' || item.status === 'paused') && item.stage !== null
        ? (
          <div className={css.actions}>
            <Button variant="ghost" size="sm" onClick={() => { onArtifact(item.id, 'design') }}>设计</Button>
            <Button variant="ghost" size="sm" onClick={() => { onArtifact(item.id, 'plan') }}>计划</Button>
            <Button variant="ghost" size="sm" onClick={() => { onArtifact(item.id, 'reviews') }}>评审记录</Button>
            <Button variant="ghost" size="sm" onClick={() => { setShowLog(!showLog) }}>
              {showLog ? '收起日志' : '日志'}
            </Button>
          </div>
        )
        : null}
      {item.status === 'done'
        ? (
          <div className={css.actions}>
            <Button variant="ghost" size="sm" onClick={() => { onArtifact(item.id, 'report') }}>查看开发报告</Button>
            {item.reportFile !== null && item.reportFile !== '' ? <span className={css.muted}>{item.reportFile}</span> : null}
          </div>
        )
        : null}
      {showLog
        ? (
          <div className={css.logList}>
            {item.log.length === 0 ? <div className={css.muted}>暂无日志</div> : null}
            {item.log.map((line, index) => <div key={index}>{`· ${line.note}`}</div>)}
          </div>
        )
        : null}
    </div>
  )
}

/** Read-only artifact text (right pane mode). */
function ArtifactPane({ title, text, onBack }: {
  title: string
  text: string
  onBack: () => void
}): JSX.Element {
  return (
    <div className={css.pane}>
      <div className={css.paneHead}>
        <Button variant="ghost" size="sm" icon={<IconChevronLeftOutline14 size={14} />} onClick={onBack}>返回</Button>
        <b className={css.paneTitle}>{title}</b>
      </div>
      <div className={css.paneScroll}><pre className={css.artifact}>{text}</pre></div>
    </div>
  )
}

/** Stage prompt editor (right pane mode): pick, edit, save, reset. */
function PromptPane({ remote, onBack }: {
  remote: DevflowRemote
  onBack: () => void
}): JSX.Element {
  const [data, setData] = useState<DevflowPromptsView | null>(null)
  const [stage, setStage] = useState('design')
  const [text, setText] = useState('')
  const [status, setStatus] = useState('')
  useEffect(() => {
    let cancelled = false
    callRemote(remote.prompts()).then((view) => {
      if (cancelled) return
      setData(view)
      setText(view.custom.design ?? view.defaults.design ?? '')
    }, (error: unknown) => {
      if (!cancelled) setStatus(`加载失败: ${errorText(error)}`)
    })
    return () => {
      cancelled = true
    }
  }, [remote])
  const pick = (next: string): void => {
    setStage(next)
    setText(data === null ? '' : data.custom[next] ?? data.defaults[next] ?? '')
    setStatus('')
  }
  const save = useCallback(() => {
    setStatus('保存中…')
    callRemote(remote['prompt-set']({ stage, template: text })).then(() => callRemote(remote.prompts()).then((view) => {
      setData(view)
      setStatus(text === view.defaults[stage] ? '已保存（与默认一致）' : '已保存 ✓')
    }), (error: unknown) => {
      setStatus(`保存失败: ${errorText(error)}`)
    }).catch((error: unknown) => {
      setStatus(`保存失败: ${errorText(error)}`)
    })
  }, [remote, stage, text])
  const reset = useCallback(() => {
    setStatus('恢复中…')
    callRemote(remote['prompt-set']({ stage, template: null })).then(() => callRemote(remote.prompts()).then((view) => {
      setData(view)
      setText(view.defaults[stage] ?? '')
      setStatus('已恢复默认 ✓')
    }), (error: unknown) => {
      setStatus(`恢复失败: ${errorText(error)}`)
    }).catch((error: unknown) => {
      setStatus(`恢复失败: ${errorText(error)}`)
    })
  }, [remote, stage])
  if (data === null) {
    return (
      <div className={css.pane}>
        <div className={css.paneHead}>
          <Button variant="ghost" size="sm" icon={<IconChevronLeftOutline14 size={14} />} onClick={onBack}>返回</Button>
          <b className={css.paneTitle}>阶段提示词自定义</b>
        </div>
        <div className={css.paneScroll}><div className={css.muted}>{status === '' ? '加载提示词…' : status}</div></div>
      </div>
    )
  }
  const vars = data.vars[stage] ?? []
  const customized = data.custom[stage] !== undefined
  return (
    <div className={css.pane}>
      <div className={css.paneHead}>
        <Button variant="ghost" size="sm" icon={<IconChevronLeftOutline14 size={14} />} onClick={onBack}>返回</Button>
        <b className={css.paneTitle}>阶段提示词自定义</b>
      </div>
      <div className={css.paneScroll}>
        <div className={css.actions}>
          <select className={css.select} value={stage} onChange={(event) => { pick(event.target.value) }}>
            {Object.keys(PROMPT_STAGE).map(key => (
              <option key={key} value={key}>{`${PROMPT_STAGE[key] ?? key}${data.custom[key] !== undefined ? '（已自定义）' : ''}`}</option>
            ))}
          </select>
          <span className={customized ? css.customized : css.muted}>{customized ? '已自定义' : '默认'}</span>
          <Button variant="primary" size="sm" onClick={() => { save() }}>保存</Button>
          <Button variant="ghost" size="sm" onClick={() => { reset() }}>恢复默认</Button>
        </div>
        <div className={css.muted}>
          {vars.length > 0 ? `可用变量: ${vars.map(v => `{{${v}}}`).join('  ')}` : '（无变量，纯文本）'}
        </div>
        <textarea className={`${css.area} ${css.editorArea}`} value={text} onChange={(event) => { setText(event.target.value) }} />
        {status !== '' ? <div className={css.muted}>{status}</div> : null}
      </div>
    </div>
  )
}

/** One grouped section of pool rows; renders nothing for an empty group. */
function Section({ title, items, selectedId, onSelect }: {
  title: string
  items: readonly DevflowItemView[]
  selectedId: string | null
  onSelect: (id: string) => void
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className={css.section}>
      <div className={css.sectionTitle}>{title}</div>
      {items.map(item => {
        const stage = item.status === 'active' && item.stage !== null ? STAGE[item.stage] ?? item.stage : null
        const waiting = item.questions !== null && item.status !== 'paused'
        return (
          <button
            key={item.id}
            type="button"
            className={`${css.row}${item.id === selectedId ? ` ${css.rowOn}` : ''}`}
            onClick={() => { onSelect(item.id) }}
          >
            <div className={css.rowTitle}>{item.title}</div>
            <div className={css.rowMeta}>
              <span>{STATUS[item.status] ?? item.status}</span>
              {stage !== null ? <span>· {stage}</span> : null}
              {waiting ? <span className={css.rowWait}>· 待决策</span> : null}
              {item.running ? <span className={css.rowRun}>· 执行中</span> : null}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/** Right-pane mode: the selected item, an artifact, or the prompt editor. */
type Pane =
  | { readonly kind: 'item' }
  | { readonly kind: 'artifact'; readonly title: string; readonly text: string }
  | { readonly kind: 'prompts' }

/**
 * The devflow main-area page. Rendered from the shell overlay layer; anchors
 * itself to the sidebar's live right edge so it reads as the center content
 * switched to a devflow view, and renders null while closed.
 * @param props.store - the shared UI store.
 * @param props.remote - the generated Remote namespace.
 * @returns the page element tree (null while closed).
 */
export function DevflowPage({ store, remote }: {
  store: DevflowUiStore
  remote: DevflowRemote
}): JSX.Element | null {
  const snap = useDevflowUi(store)
  const view = snap.view
  const [left, setLeft] = useState(DEFAULT_LEFT_PX)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>({ kind: 'item' })
  const [kind, setKind] = useState<'requirement' | 'bug'>('requirement')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const items = view?.items ?? []
  const selected = selectedId === null ? undefined : items.find(i => i.id === selectedId)
  // Drop a selection whose item disappeared (done items are pruned by the
  // host); the artifact panes keep their own text copy and need no guard.
  useEffect(() => {
    if (selectedId !== null && selected === undefined) setSelectedId(null)
  }, [selectedId, selected])

  // Measure the sidebar column (the frame's first grid child, reached through
  // the overlay layer's documented data hook) and follow drags/collapses.
  useEffect(() => {
    if (!snap.open) return
    const el = rootRef.current
    if (el === null) return
    const column = el.closest('[data-shell-overlay]')?.parentElement?.firstElementChild
    if (column === null || column === undefined || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const width = column.getBoundingClientRect().width
      if (width > 0) setLeft(width)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    return () => { observer.disconnect() }
  }, [snap.open])

  // Escape unwinds the pane stack first, then closes the page.
  useEffect(() => {
    if (!snap.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (pane.kind !== 'item') setPane({ kind: 'item' })
      else store.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [snap.open, pane.kind, store])

  // Land focus on the page surface when it opens (baseline focus management).
  useEffect(() => {
    if (snap.open) rootRef.current?.focus()
  }, [snap.open])

  const submit = useCallback(() => {
    if (text.trim() === '') return
    setSending(true)
    callRemote(remote.submit({ kind, text })).then(() => {
      setText('')
      setSubmitError('')
      store.refresh()
    }, (error: unknown) => {
      setSubmitError(errorText(error))
    }).catch(() => undefined).finally(() => {
      setSending(false)
    })
  }, [remote, store, kind, text])

  const openArtifact = useCallback((itemId: string, name: 'design' | 'plan' | 'report' | 'reviews') => {
    callRemote(remote.artifact({ itemId, name })).then(
      (value: string) => {
        setPane({ kind: 'artifact', title: `${itemId} · ${name === 'reviews' ? '评审记录' : name === 'report' ? '开发报告' : name === 'design' ? '设计' : '计划'}`, text: value })
      },
      (error: unknown) => {
        setPane({ kind: 'artifact', title: '读取失败', text: errorText(error) })
      },
    ).catch(() => undefined)
  }, [remote])

  if (!snap.open) return null

  const active = items.filter(i => i.status === 'active')
  const waiting = items.filter(i => i.questions !== null && i.status !== 'active' && i.status !== 'paused')
  const pool = items.filter(i => i.questions === null && i.status !== 'active' && i.status !== 'done'
    && i.status !== 'paused' && i.status !== 'rejected')
  const paused = items.filter(i => i.status === 'paused')
  const rejected = items.filter(i => i.status === 'rejected')
  const done = items.filter(i => i.status === 'done')
  const busy = view !== null && view.busy
  const statusLine = snap.offline
    ? '连接已断开，重试中…'
    : view?.note != null
      ? view.note
      : view === null
        ? '…'
        : `${active.length} 进行中 · ${waiting.length} 待决策 · ${done.length} 已完成`

  return (
    <div
      ref={rootRef}
      className={css.page}
      style={{ left: `${Math.round(left)}px` }}
      role="dialog"
      aria-modal="false"
      aria-label="自动开发流水线"
      tabIndex={-1}
    >
      <header className={css.header}>
        <span className={`${css.dot}${busy ? ` ${css.dotLive}` : ''}`} aria-hidden="true" />
        <div className={css.titleBlock}>
          <b className={css.title}>自动开发流水线</b>
          <span className={css.subtitle}>{statusLine}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { setPane({ kind: 'prompts' }) }}>提示词</Button>
        <Button variant="ghost" size="sm" aria-label="关闭" onClick={() => { store.close() }}>
          <IconCloseOutline16 size={14} />
        </Button>
      </header>
      {snap.offline ? <div className={css.noticeBar}>⚠ 与宿主的连接中断，正在自动重试</div> : null}
      {view?.error != null ? <div className={css.noticeBar}>{`⚠ ${view.error}`}</div> : null}
      <div className={css.body}>
        <aside className={css.pool}>
          <div className={css.poolScroll}>
            <div className={css.form}>
              <div className={css.sectionTitle}>需求池入口</div>
              <textarea
                className={css.area}
                placeholder="投入粗浅的需求或 bug 描述…"
                value={text}
                onChange={(event) => { setText(event.target.value) }}
              />
              <div className={css.actions}>
                <Button variant="ghost" size="sm" onClick={() => { setKind(kind === 'bug' ? 'requirement' : 'bug') }}>
                  {kind === 'bug' ? 'bug' : '需求'}
                </Button>
                <span className={css.spacer} />
                <Button variant="primary" size="sm" disabled={sending || text.trim() === ''} onClick={() => { submit() }}>
                  投入需求池
                </Button>
              </div>
              {submitError !== '' ? <div className={css.errorText}>{`⚠ ${submitError}`}</div> : null}
            </div>
            <Section title={`流水线进行中 (${active.length})`} items={active} selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setPane({ kind: 'item' }) }} />
            <Section title={`等待队列 · 需你决策 (${waiting.length})`} items={waiting} selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setPane({ kind: 'item' }) }} />
            <Section title="已暂停（不会自动重跑）" items={paused} selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setPane({ kind: 'item' }) }} />
            <Section title="需求池" items={pool} selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setPane({ kind: 'item' }) }} />
            <Section title="搁置" items={rejected} selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setPane({ kind: 'item' }) }} />
            <Section title={`已完成 (${done.length})`} items={done} selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setPane({ kind: 'item' }) }} />
            {items.length === 0
              ? (
                <div className={css.emptyPool}>
                  池为空。投入第一条需求后，后台将自动：批量精炼（含规模评估）→ 择优 → 设计 → 计划 →
                  评审修复(≤3轮) → 实施（小需求主工作区/中大需求worktree）→ 代码评审(≤3轮) → Web验证 →
                  合并回main → 报告。
                </div>
              )
              : null}
          </div>
        </aside>
        <main className={css.detail}>
          {pane.kind === 'prompts'
            ? <PromptPane remote={remote} onBack={() => { setPane({ kind: 'item' }) }} />
            : pane.kind === 'artifact'
              ? <ArtifactPane title={pane.title} text={pane.text} onBack={() => { setPane({ kind: 'item' }) }} />
              : selected !== undefined
                ? (
                  <ItemDetail
                    item={selected}
                    remote={remote}
                    store={store}
                    onArtifact={openArtifact}
                  />
                )
                : (
                  <div className={css.emptyDetail}>从左侧选择一条需求查看详情</div>
                )}
        </main>
      </div>
    </div>
  )
}

/** Element factory for the .ts registration entry (no JSX at that side). */
export function renderPage(store: DevflowUiStore, remote: DevflowRemote): JSX.Element {
  return <DevflowPage store={store} remote={remote} />
}
