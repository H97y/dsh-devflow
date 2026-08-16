/**
 * The devflow control panel: requirement-pool entry, live pipeline sections,
 * per-item waiting questions, artifact viewer, and the stage prompt editor.
 * State arrives by polling the host service through the generated Remote
 * namespace; every mutation is a plain Remote call.
 *
 * @module @deepseek-ai/dsh-devflow/client/panel
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type {
  DevflowAnswer, DevflowItemView, DevflowPromptsView, DevflowQuestion, DevflowView,
} from '../types.ts'
import css from './panel.module.css'

/** Render an unknown error value as short text without String(anything). */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error)
}

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
      {questions.map((question, index) => (
        <div key={index}>
          <div className={css.question}>{`${question.recommend !== undefined ? '⭐ ' : ''}${question.q}`}</div>
          <div className={css.options}>
            {question.options.map((option, optionIndex) => {
              const key = keyOf(question)
              return (
                <button
                  key={optionIndex}
                  type="button"
                  className={`${css.option}${selected[key] === option.label ? ` ${css.optionOn}` : ''}`}
                  onClick={() => { setSelected({ ...selected, [key]: option.label }) }}
                >
                  {`${option.label}${question.recommend === option.label ? ' ✓' : ''}`}
                </button>
              )
            })}
          </div>
          <textarea
            className={css.smallArea}
            placeholder="补充说明（可选）"
            value={notes[keyOf(question)] ?? ''}
            onChange={(event) => { setNotes({ ...notes, [keyOf(question)]: event.target.value }) }}
          />
        </div>
      ))}
      <div className={css.row}>
        <button type="button" className={`${css.button} ${css.buttonSmall}`} disabled={sending} onClick={submit}>
          提交答复
        </button>
      </div>
    </div>
  )
}

/** One pool/pipeline card with badges, controls, and the capped log tail. */
function Card({ item, view, onAnswer, onCancel, onResume, onRetry }: {
  item: DevflowItemView
  view: (itemId: string, name: 'design' | 'plan' | 'report' | 'reviews') => void
  onAnswer: (itemId: string, stage: string | null, answers: DevflowAnswer[]) => Promise<void>
  onCancel: (itemId: string) => Promise<void>
  onResume: (itemId: string) => Promise<void>
  onRetry: (itemId: string) => Promise<void>
}): JSX.Element {
  const [showLog, setShowLog] = useState(false)
  const badges: JSX.Element[] = [
    <span key="kind" className={`${css.badge}${item.kind === 'bug' ? ` ${css.badgeBug}` : ''}`}>
      {item.kind === 'bug' ? 'bug' : '需求'}
    </span>,
    <span key="status" className={css.badge}>{STATUS[item.status] ?? item.status}</span>,
  ]
  if (item.size !== null) {
    const sizeClass = item.size === 'medium' ? css.badgeSizeM : item.size === 'large' ? css.badgeSizeL : css.badgeSizeS
    badges.push(<span key="size" className={`${css.badge} ${sizeClass}`}>{SIZE[item.size] ?? item.size}</span>)
  }
  if (item.score !== null) {
    badges.push(
      <span key="score" className={css.badge}>{`价值${item.score.value}·完整${item.score.completeness}`}</span>,
    )
  }
  if (item.status === 'active' && item.stage !== null) {
    badges.push(<span key="stage" className={`${css.badge} ${css.badgeStage}`}>{STAGE[item.stage] ?? item.stage}</span>)
  }
  if (item.status === 'active' && item.round > 0) {
    badges.push(<span key="round" className={css.badge}>{`第${item.round}轮`}</span>)
  }
  if (item.workspaceKind !== null) {
    badges.push(
      <span key="ws" className={`${css.badge} ${css.badgeWorkspace}`}>
        {item.workspaceKind === 'main' ? '🖥 主工作区' : `🌿 ${item.workspaceBranch ?? 'worktree'}`}
      </span>,
    )
  }
  if (item.running) {
    badges.push(<span key="run" className={`${css.badge} ${css.badgeRun}`}>{`▶ ${item.note ?? '执行中'}`}</span>)
  } else if (item.note !== null) {
    badges.push(<span key="note" className={`${css.badge} ${css.badgeStage}`}>{`⏸ ${item.note}`}</span>)
  }
  if (item.resourceWaiting !== null) {
    badges.push(
      <span key="rw" className={`${css.badge} ${css.badgeWait}`}>
        {`⏳ ${item.resourceWaiting === 'workspace' ? '等待主工作区' : '等待worktree'}`}
      </span>,
    )
  }
  if (item.status === 'paused' && item.stage !== null) {
    badges.push(<span key="bp" className={`${css.badge} ${css.badgePaused}`}>{`断点·${STAGE[item.stage] ?? item.stage}`}</span>)
  }
  if (item.questions !== null) {
    const where = item.waitingStage === null ? '需求补充' : STAGE[item.waitingStage] ?? item.waitingStage
    badges.push(<span key="q" className={`${css.badge} ${css.badgeWait}`}>{`待决策·${where}`}</span>)
  }
  if (item.status === 'done') {
    badges.push(<span key="done" className={`${css.badge} ${css.badgeOk}`}>✓ 已交付</span>)
  }
  if (item.status === 'rejected') {
    badges.push(<span key="rej" className={`${css.badge} ${css.badgeRejected}`}>{item.rejectReason || '搁置'}</span>)
  }
  return (
    <div className={`${css.card}${item.status === 'active' ? ` ${css.cardActive}` : ''}`}>
      <div className={css.cardTitle}>{item.title}</div>
      <div className={css.badges}>{badges}</div>
      <div className={css.preview}>{item.preview}</div>
      {item.questions !== null && item.status !== 'paused'
        ? <Questions item={item} onAnswer={onAnswer} />
        : null}
      {item.error !== null
        ? (
          <div className={css.error}>
            {`⚠ ${item.error} `}
            <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`} onClick={() => { void onRetry(item.id) }}>
              重试
            </button>
          </div>
        )
        : null}
      {item.status === 'active' || item.status === 'refining' || item.status === 'needs-user'
        ? (
          <div className={css.row}>
            <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonStop}`} onClick={() => { void onCancel(item.id) }}>
              {item.status === 'needs-user' ? '暂停并收起问题' : '中 断'}
            </button>
          </div>
        )
        : null}
      {item.status === 'paused'
        ? (
          <div className={css.row}>
            <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGo}`} onClick={() => { void onResume(item.id) }}>
              ▶ 继 续
            </button>
            {item.questions !== null
              ? (
                <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`} onClick={() => { void onResume(item.id) }}>
                  重新回答问题
                </button>
              )
              : null}
          </div>
        )
        : null}
      {(item.status === 'active' || item.status === 'paused') && item.stage !== null
        ? (
          <div className={css.row}>
            <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`} onClick={() => { view(item.id, 'design') }}>设计</button>
            <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`} onClick={() => { view(item.id, 'plan') }}>计划</button>
            <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`} onClick={() => { view(item.id, 'reviews') }}>评审记录</button>
            <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`} onClick={() => { setShowLog(!showLog) }}>
              {showLog ? '收起日志' : '日志'}
            </button>
          </div>
        )
        : null}
      {item.status === 'done'
        ? (
          <div className={css.row}>
            <button type="button" className={`${css.button} ${css.buttonSmall}`} onClick={() => { view(item.id, 'report') }}>查看开发报告</button>
            <span className={css.mini}>{item.reportFile ?? ''}</span>
          </div>
        )
        : null}
      {showLog
        ? <div className={css.logList}>{item.log.map((line, index) => <div key={index}>{`· ${line.note}`}</div>)}</div>
        : null}
    </div>
  )
}

/** One labeled group of cards; renders nothing for an empty group. */
function Section({ title, items, card }: {
  title: string
  items: readonly DevflowItemView[]
  card: (item: DevflowItemView) => JSX.Element
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div>
      <div className={css.section}>{title}</div>
      {items.map(item => card(item))}
    </div>
  )
}

/** Plain-text artifact viewer. */
function ArtifactViewer({ title, text, onClose }: {
  title: string
  text: string
  onClose: () => void
}): JSX.Element {
  return (
    <div className={css.viewer}>
      <div className={css.viewerHead}>
        <b>{title}</b>
        <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`} onClick={() => { onClose() }}>关闭 ✕</button>
      </div>
      <div>{text}</div>
    </div>
  )
}

/** Stage prompt editor: pick, edit, save, reset; header close never collapses. */
function PromptEditor({ remote, onClose }: {
  remote: DevflowRemote
  onClose: () => void
}): JSX.Element {
  const [data, setData] = useState<DevflowPromptsView | null>(null)
  const [stage, setStage] = useState('design')
  const [text, setText] = useState('')
  const [status, setStatus] = useState('')
  useEffect(() => {
    let cancelled = false
    remote.prompts().then((view) => {
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
    remote.promptSet({ stage, template: text }).then(() => remote.prompts().then((view) => {
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
    remote.promptSet({ stage, template: null }).then(() => remote.prompts().then((view) => {
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
      <div className={css.promptEditor}>
        <div className={css.editorHead}>
          <b className={css.editorTitle}>⚙ 阶段提示词自定义</b>
          <button type="button" className={css.close} onClick={() => { onClose() }}>✕</button>
        </div>
        <div className={css.mini}>{status === '' ? '加载提示词…' : status}</div>
      </div>
    )
  }
  const vars = data.vars[stage] ?? []
  const customized = data.custom[stage] !== undefined
  return (
    <div className={css.promptEditor}>
      <div className={css.editorHead}>
        <b className={css.editorTitle}>⚙ 阶段提示词自定义</b>
        <button type="button" className={css.close} onClick={() => { onClose() }}>✕</button>
      </div>
      <div className={css.row}>
        <select className={css.select} value={stage} onChange={(event) => { pick(event.target.value) }}>
          {Object.keys(PROMPT_STAGE).map(key => (
            <option key={key} value={key}>{`${PROMPT_STAGE[key] ?? key}${data.custom[key] !== undefined ? ' ✏️' : ''}`}</option>
          ))}
        </select>
        <span className={css.mini}>{customized ? '✏️ 已自定义' : '默认'}</span>
        <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGo}`} onClick={() => { save() }}>保存</button>
        <button type="button" className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`} onClick={() => { reset() }}>恢复默认</button>
      </div>
      <div className={css.mini}>
        {vars.length > 0 ? `可用变量: ${vars.map(v => `{{${v}}}`).join('  ')}` : '（无变量，纯文本）'}
      </div>
      <textarea className={css.editorArea} value={text} onChange={(event) => { setText(event.target.value) }} />
      {status !== '' ? <div className={css.mini}>{status}</div> : null}
    </div>
  )
}

/** The generated devflow Remote namespace this panel consumes. */
export interface DevflowRemote {
  state(): Promise<DevflowView>
  submit(request: { kind: 'requirement' | 'bug'; text: string }): Promise<{ ok: boolean; id: string }>
  answer(request: { itemId: string; stage: string | null; answers: DevflowAnswer[] }): Promise<{ ok: boolean }>
  cancel(request: { itemId: string }): Promise<{ ok: boolean }>
  resume(request: { itemId: string }): Promise<{ ok: boolean }>
  retry(request: { itemId: string }): Promise<{ ok: boolean }>
  artifact(request: { itemId: string; name: 'design' | 'plan' | 'report' | 'reviews' }): Promise<string>
  prompts(): Promise<DevflowPromptsView>
  promptSet(request: { stage: string; template: string | null }): Promise<{ ok: boolean }>
}

/** Panel props. */
export interface PanelProps {
  remote: DevflowRemote
}

/** The whole panel: entry form, live sections, viewers. */
export default function Panel({ remote }: PanelProps): JSX.Element {
  const [view, setView] = useState<DevflowView | null>(null)
  const [open, setOpen] = useState(true)
  const [kind, setKind] = useState<'requirement' | 'bug'>('requirement')
  const [text, setText] = useState('')
  const [artifact, setArtifact] = useState<{ title: string; text: string } | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const refresh = useCallback(() => {
    remote.state().then((value: DevflowView) => { setView(value) }, (error: unknown) => {
      setView({ busy: false, note: null, error: errorText(error), items: [] })
    }).catch(() => undefined)
  }, [remote])
  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 1500)
    return () => {
      window.clearInterval(timer)
    }
  }, [refresh])
  const submit = useCallback(() => {
    if (text.trim() === '') return
    setSending(true)
    remote.submit({ kind, text }).then(() => {
      setText('')
      setSubmitError('')
    }, (error: unknown) => {
      setSubmitError(errorText(error))
    }).catch(() => undefined).finally(() => {
      setSending(false)
    })
  }, [remote, kind, text])
  const openArtifact = useCallback((itemId: string, name: 'design' | 'plan' | 'report' | 'reviews') => {
    remote.artifact({ itemId, name }).then(
      (value: string) => { setArtifact({ title: `${itemId} · ${name}`, text: value }) },
      (error: unknown) => { setArtifact({ title: '读取失败', text: errorText(error) }) },
    ).catch(() => undefined)
  }, [remote])
  const onAnswer = useCallback(async (itemId: string, stage: string | null, answers: DevflowAnswer[]) => {
    await remote.answer({ itemId, stage, answers })
  }, [remote])
  const onCancel = useCallback(async (itemId: string) => {
    await remote.cancel({ itemId })
  }, [remote])
  const onResume = useCallback(async (itemId: string) => {
    await remote.resume({ itemId })
  }, [remote])
  const onRetry = useCallback(async (itemId: string) => {
    await remote.retry({ itemId })
  }, [remote])
  const renderCard = useCallback((item: DevflowItemView) => (
    <Card
      key={item.id}
      item={item}
      view={openArtifact}
      onAnswer={onAnswer}
      onCancel={onCancel}
      onResume={onResume}
      onRetry={onRetry}
    />
  ), [openArtifact, onAnswer, onCancel, onResume, onRetry])
  const items = view?.items ?? []
  const active = items.filter(i => i.status === 'active')
  const waiting = items.filter(i => i.status !== 'active' && i.questions !== null && i.status !== 'paused')
  const pool = items.filter(i => i.status !== 'active' && i.questions === null && i.status !== 'done' && i.status !== 'paused')
  const paused = items.filter(i => i.status === 'paused')
  const done = items.filter(i => i.status === 'done')
  const live = view !== null && (view.busy || view.note !== null)
  const editor = editorOpen
    ? <PromptEditor remote={remote} onClose={() => { setEditorOpen(false) }} />
    : null
  const viewer = artifact === null
    ? null
    : <ArtifactViewer title={artifact.title} text={artifact.text} onClose={() => { setArtifact(null) }} />
  if (!open) {
    return (
      <div>
        {editor}
        {viewer}
        <div className={`${css.panel} ${css.collapsed}`}>
          <div className={css.head} onClick={() => { setOpen(true) }}>
            <span className={`${css.dot}${live ? '' : ` ${css.dotOff}`}`} />
            <b className={css.title}>星海流水线</b>
            <span className={css.mini}>
              {view === null
                ? '…'
                : `${active.length} 进行中 · ${items.filter(i => i.questions !== null).length} 待决策`}
            </span>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div>
      {editor}
      {viewer}
      <div className={css.panel}>
        <div className={css.head} onClick={() => { setOpen(false) }}>
          <span className={`${css.dot}${live ? '' : ` ${css.dotOff}`}`} />
          <b className={css.title}>星海自动开发流水线</b>
          <span className={css.spacer} />
          <button
            type="button"
            className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`}
            onClick={(event) => {
              event.stopPropagation()
              setEditorOpen(true)
            }}
          >
            ⚙ 提示词
          </button>
          <span className={css.mini}>收起 ▾</span>
        </div>
        <div className={css.body}>
          <div className={css.form}>
            <div className={css.section}>📥 需求池入口</div>
            <textarea
              className={css.inputArea}
              placeholder="投入粗浅的需求或 bug 描述…"
              value={text}
              onChange={(event) => { setText(event.target.value) }}
            />
            <div className={css.row}>
              <button
                type="button"
                className={`${css.button} ${css.buttonSmall} ${css.buttonGhost}`}
                onClick={() => { setKind(kind === 'bug' ? 'requirement' : 'bug') }}
              >
                {kind === 'bug' ? '🐞 bug' : '✨ 需求'}
              </button>
              <span className={css.spacer} />
              <button
                type="button"
                className={css.button}
                disabled={sending || text.trim() === ''}
                onClick={() => { submit() }}
              >
                投入需求池
              </button>
            </div>
            {submitError !== '' ? <div className={css.error}>{`⚠ ${submitError}`}</div> : null}
          </div>
          {view?.note != null
            ? <div className={css.noteBar}>{`▶ ${view.note}`}</div>
            : null}
          {view?.error != null
            ? <div className={css.error}>{`⚠ ${view.error}`}</div>
            : null}
          <Section
            title={`⚙️ 流水线进行中 (${active.length})`}
            items={active}
            card={renderCard}
          />
          <Section
            title={'⏳ 等待队列（需你决策/补充）'}
            items={waiting}
            card={renderCard}
          />
          <Section
            title={'⛔ 已暂停（不会自动重跑）'}
            items={paused}
            card={renderCard}
          />
          <Section
            title={'🗂 需求池'}
            items={pool}
            card={renderCard}
          />
          <Section
            title={`✅ 已完成 (${done.length})`}
            items={done}
            card={renderCard}
          />
          {items.length === 0
            ? (
              <div className={css.preview}>
                池为空。投入第一条需求后，后台将自动：批量精炼（含规模评估）→ 择优 → 设计 → 计划 →
                评审修复(≤3轮) → 实施（小需求主工作区/中大需求worktree）→ 代码评审(≤3轮) → Web验证 →
                合并回main → 报告。
              </div>
            )
            : null}
        </div>
      </div>
    </div>
  )
}

/** Render the whole panel for the shell overlay. */
export function renderPanel(remote: DevflowRemote): JSX.Element {
  return <Panel remote={remote} />
}
