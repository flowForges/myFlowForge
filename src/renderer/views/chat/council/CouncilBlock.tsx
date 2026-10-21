import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, ProviderInfo } from '@shared/types'
import { isCouncilProvider, type CouncilSeat, type CouncilState } from '@shared/council'
import type { CouncilApi } from '../../../state/useCouncil'
import { Markdown } from '../markdown'
import { Logo, SeatPicker, makeSeat, asLeader, CHEV } from './CouncilSetup'
import { CouncilResultCard } from './CouncilResultCard'
import './council.css'

export type CouncilControls = Pick<CouncilApi, 'pause' | 'resume' | 'stop' | 'followup' | 'choose'>

type Props = {
  id: string
  messages: ChatMessage[]
  /** 状态快照可能比消息晚到;没有时只按消息画。 */
  state?: CouncilState
  streamingIds: ReadonlySet<string>
  providers: ProviderInfo[]
  controls: CouncilControls
}

type SeatInfo = { provider: string; label: string; color: string }

// 席位左侧色条:按席位在配置里的顺序取色;同一家 CLI 的两个模型也能分开。领导者固定用强调色。
const SEAT_COLORS = [
  'oklch(68% .15 250)', 'oklch(70% .15 150)', 'oklch(72% .15 60)',
  'oklch(66% .17 20)', 'oklch(68% .14 300)', 'oklch(72% .12 200)',
]
const LEADER_COLOR = 'var(--accent)'
const isLeader = (seat?: string) => !!seat && seat.startsWith('leader:')
const LIVE = new Set<CouncilState['status']>(['running', 'paused', 'finalizing'])

const chars = (s: string, n: number) => Array.from(s.trim()).slice(0, n).join('')
const pad = (n: number) => String(n).padStart(2, '0')
function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

/** 和主进程 parseVote 同一判法:先判「不同意」(它包含「同意」)。 */
function voteOf(text: string): 'agree' | 'disagree' | 'unknown' {
  const head = text.replace(/^[\s*_#>`~\-"'“「【[(（]+/, '')
  if (head.startsWith('不同意')) return 'disagree'
  if (head.startsWith('同意')) return 'agree'
  return 'unknown'
}

const EXPAND_ICON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>

// ---- 单条发言:按消息 memo(同 Message),流式时只有那一条重渲染 ----

const SeatRow = memo(function SeatRow({ msg, seat, streaming }: { msg: ChatMessage; seat: SeatInfo; streaming: boolean }) {
  return (
    <div className="council-row" data-seat={msg.council?.seat} style={{ '--seat': seat.color } as React.CSSProperties}>
      <div className="council-who-line"><Logo id={seat.provider} /><span>{seat.label}</span></div>
      <div className="msg-body ans"><Markdown text={msg.text} streaming={streaming} />{streaming && <span className="pending" />}</div>
    </div>
  )
})

const SummaryCard = memo(function SummaryCard({ msg, seat, streaming }: { msg: ChatMessage; seat: SeatInfo; streaming: boolean }) {
  return (
    <div className="council-summary" data-seat={msg.council?.seat} data-stage={msg.council?.stage}>
      <div className="council-who-line"><span aria-hidden="true">👑</span><Logo id={seat.provider} /><span>{seat.label}</span></div>
      <div className="msg-body ans"><Markdown text={msg.text} streaming={streaming} />{streaming && <span className="pending" />}</div>
    </div>
  )
})

const AnswerCard = memo(function AnswerCard({ msg, seat, streaming }: { msg: ChatMessage; seat: SeatInfo; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  // ★流式时卡片内跟着滚到底(§6.2),收起状态下也能看到正在写的那几行
  useEffect(() => {
    if (streaming && !open && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [msg.text, streaming, open])
  return (
    <div className={`council-card${open ? ' open' : ''}`} data-seat={msg.council?.seat} style={{ '--seat': seat.color } as React.CSSProperties}>
      <div className="council-who-line">
        <Logo id={seat.provider} /><span>{seat.label}</span>
        <button type="button" className="council-more" aria-expanded={open} aria-label={open ? '收起' : '展开'} onClick={() => setOpen(o => !o)}>{EXPAND_ICON}</button>
      </div>
      <div ref={body} className={`council-card-body msg-body ans${streaming ? ' live' : ''}`}>
        <Markdown text={msg.text} streaming={streaming} />{streaming && <span className="pending" />}
      </div>
    </div>
  )
})

function FailedChip({ msg, seat }: { msg: ChatMessage; seat: SeatInfo }) {
  return (
    <span className="council-failed" data-seat={msg.council?.seat}>
      <Logo id={seat.provider} /><span>{seat.label}</span><span className="council-x" aria-hidden="true">✕</span>
    </span>
  )
}

function UserRow({ msg, className }: { msg: ChatMessage; className: string }) {
  return (
    <div className={`msg user ${className}`}>
      <div className="msg-body user-body"><div className="user-bubble">{msg.text}</div></div>
    </div>
  )
}

/** 一轮里的发言(第 1 轮的并排卡片之外):逐条按出现顺序画,连续的投票收成一排徽标。 */
function Utterances({ list, seatOf, streamingIds }: {
  list: ChatMessage[]
  seatOf: (m: ChatMessage) => SeatInfo
  streamingIds: ReadonlySet<string>
}) {
  const out: React.ReactNode[] = []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const stage = m.council?.stage
    if (stage === 'consensus-vote') {
      const votes: ChatMessage[] = []
      while (i < list.length && list[i].council?.stage === 'consensus-vote') votes.push(list[i++])
      i--
      out.push(
        <div className="council-votes" key={`v-${m.id}`}>
          {votes.map(v => {
            const s = seatOf(v)
            const vote = streamingIds.has(v.id) ? 'unknown' : voteOf(v.text)
            return (
              <span key={v.id} className="council-vote" data-vote={vote} data-seat={v.council?.seat} title={v.text}>
                <Logo id={s.provider} />{vote === 'agree' ? '✓' : vote === 'disagree' ? '✕' : '…'}
              </span>
            )
          })}
        </div>,
      )
      continue
    }
    const streaming = streamingIds.has(m.id)
    if (m.who === 'user') out.push(<UserRow key={m.id} msg={m} className={stage === 'followup' ? 'council-ask' : 'council-interject'} />)
    else if (stage === 'failed') out.push(<div className="council-failed-row" key={m.id}><FailedChip msg={m} seat={seatOf(m)} /></div>)
    else if (stage === 'summary' || stage === 'consensus-draft' || stage === 'final') out.push(<SummaryCard key={m.id} msg={m} seat={seatOf(m)} streaming={streaming} />)
    else out.push(<SeatRow key={m.id} msg={m} seat={seatOf(m)} streaming={streaming} />)
  }
  return <>{out}</>
}

// ---- 区块 ----

export function CouncilBlock({ id, messages, state, streamingIds, providers, controls }: Props) {
  const status = state?.status
  const live = !!status && LIVE.has(status)

  // 席位信息:优先用配置(颜色按配置顺序),消息里自带的 provider / model(= 席位 label)兜底。
  // ★只在出现新席位时重算 —— 流式增量每次都换 messages,SeatInfo 跟着换会让 memo 过的每一行都重渲染
  // ★状态推送每次都是新对象:按席位内容(而不是 state.config 引用)判断要不要重算
  const seatKey = [...new Set(messages.map(m => m.council?.seat).filter(Boolean))].join('|')
  const cfgKey = state
    ? [...state.config.seats, state.config.leader].map(s => `${s.id}\u0001${s.provider}\u0001${s.label}`).join('|')
    : ''
  const seats = useMemo(() => {
    const map = new Map<string, SeatInfo>()
    state?.config.seats.forEach((s, i) => map.set(s.id, { provider: s.provider, label: s.label, color: SEAT_COLORS[i % SEAT_COLORS.length] }))
    if (state) map.set(state.config.leader.id, { provider: state.config.leader.provider, label: state.config.leader.label, color: LEADER_COLOR })
    for (const m of messages) {
      const sid = m.council?.seat
      if (!sid || map.has(sid)) continue
      const color = isLeader(sid) ? LEADER_COLOR : SEAT_COLORS[[...map.keys()].filter(k => !isLeader(k)).length % SEAT_COLORS.length]
      map.set(sid, { provider: m.provider ?? '', label: m.model ?? sid, color })
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey, seatKey])
  const seatOf = (m: ChatMessage): SeatInfo =>
    seats.get(m.council?.seat ?? '') ?? { provider: m.provider ?? '', label: m.model ?? '', color: SEAT_COLORS[0] }
  const seatLabel = useCallback((sid: string) => seats.get(sid)?.label ?? sid, [seats])
  const { choose } = controls
  const onChoose = useCallback((name: string) => choose(id, name), [choose, id])

  // ★追问在最终结果之后:第一条追问起的全部消息都归「追问」段,不混进最后一轮
  const { topicMsg, rounds, final, followups } = useMemo(() => {
    const fu = messages.findIndex(m => m.council?.stage === 'followup')
    const main = fu < 0 ? messages : messages.slice(0, fu)
    const topicMsg = main.find(m => m.council?.stage === 'topic')
    const final = main.filter(m => m.council?.stage === 'final').at(-1)
    const rounds = new Map<number, ChatMessage[]>()
    for (const m of main) {
      if (m === topicMsg || m === final) continue
      const r = m.council?.round ?? 1
      rounds.set(r, [...(rounds.get(r) ?? []), m])
    }
    return { topicMsg, rounds: [...rounds.entries()].sort((a, b) => a[0] - b[0]), final, followups: fu < 0 ? [] : messages.slice(fu) }
  }, [messages])
  const finalStreaming = !!final && streamingIds.has(final.id)

  const ended = status ? !LIVE.has(status) : !!final && !finalStreaming
  // ★没点过就跟着状态走(进行中展开、结束后收起);点过一次就以用户为准,本次会话内保持
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? !ended

  // 用时:进行中每秒走一次;暂停 / 结束后用状态里冻结的那个数
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (status !== 'running') return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [status])
  const elapsed = state ? (status === 'running' ? Math.max(state.elapsedMs, now - state.startedAt) : state.elapsedMs) : 0

  const topic = state?.config.topic ?? topicMsg?.text ?? ''
  const seatCount = state?.config.seats.length ?? new Set(messages.map(m => m.council?.seat).filter(s => s && !isLeader(s))).size
  const roundsSoFar = state?.round || Math.max(0, ...messages.map(m => m.council?.round ?? 0))
  const header = `AI 共商 · ${chars(topic, 20)} · ${seatCount} 方 · ${roundsSoFar} 轮 · ${elapsed > 0 ? Math.max(1, Math.round(elapsed / 60_000)) : 0} 分钟`

  // 领导者失败后暂停:最后一条 AI 发言是领导者的 failed —— 「继续」旁边可以换一位领导者
  const lastAi = [...messages].reverse().find(m => m.who === 'ai')
  const leaderFailed = status === 'paused' && lastAi?.council?.stage === 'failed' && isLeader(lastAi.council.seat)
  const [newLeader, setNewLeader] = useState<CouncilSeat | undefined>(undefined)
  const pickable = useMemo(
    () => providers.filter(p => p.installed && isCouncilProvider(p.id) && p.models.length > 0),
    [providers],
  )
  useEffect(() => { if (!leaderFailed) setNewLeader(undefined) }, [leaderFailed])

  const [q, setQ] = useState('')
  const [target, setTarget] = useState<'all' | string>('all')
  // 本次提交的追问:提交时已有几条追问 + 问的是谁。用来判断「这一问还没答完」。
  const [asked, setAsked] = useState<{ before: number; target: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const busy = useMemo(() => {
    if (submitting || followups.some(m => streamingIds.has(m.id))) return true
    if (status === 'done' && (state?.speaking.length ?? 0) > 0) return true
    if (!asked) return false
    const questions = followups.filter(m => m.who === 'user')
    if (questions.length <= asked.before) return true   // 问题还没回到消息里
    const last = questions[questions.length - 1]
    const answers = followups.slice(followups.indexOf(last) + 1).filter(m => m.who === 'ai').length
    // ★问全体 = 依次问还在场的席位;连续失败两次被淘汰的(主讨论里最后两条都是 failed)不会再答
    const inPlay = (state?.config.seats ?? []).filter(s => {
      const own = messages.filter(m => m.who === 'ai' && m.council?.seat === s.id && !followups.includes(m))
      return !(own.length >= 2 && own.slice(-2).every(m => m.council?.stage === 'failed'))
    }).length
    return answers < (asked.target === 'all' ? inPlay : 1)
  }, [submitting, followups, streamingIds, status, state, asked, messages])

  const ask = async () => {
    const text = q.trim()
    if (!text || busy) return
    setSubmitting(true)
    const before = followups.filter(m => m.who === 'user').length
    const ok = await controls.followup(id, text, target)
    setSubmitting(false)
    // ★失败(已弹提示)不清空,问题留在框里可以再发
    if (ok === false) return
    setAsked({ before, target })
    setQ('')
    setUserOpen(true)   // 追问的问答在区块里,收着就看不到
  }

  return (
    <section className={`council-block${open ? ' open' : ''}`} data-council={id} data-status={status}>
      <button type="button" className="council-head" aria-expanded={open} onClick={() => setUserOpen(!open)}>
        <span className="council-title">{header}</span>
        <span className="council-chev" aria-hidden="true">{EXPAND_ICON}</span>
      </button>

      {live && state && (
        <div className="council-status">
          <span className="council-round">{state.totalRounds ? `第 ${state.round} / ${state.totalRounds} 轮` : `第 ${state.round} 轮`}</span>
          <span className="council-speaking">
            {state.speaking.map(sid => (
              <span key={sid} data-speaking={sid}><Logo id={seats.get(sid)?.provider ?? ''} /></span>
            ))}
          </span>
          <span className="council-elapsed">{mmss(elapsed)}</span>
          <span className="council-spacer" />
          {leaderFailed && (
            <SeatPicker
              className="council-leader"
              label={`👑 ${newLeader?.label ?? ''}`.trim()}
              trigger={<>👑{newLeader && <><Logo id={newLeader.provider} /><span>{newLeader.label}</span></>}{CHEV}</>}
              providers={pickable}
              onPick={(p, m) => setNewLeader(asLeader(makeSeat(p, m)))}
            />
          )}
          {status === 'running' && <button type="button" className="council-ctl" onClick={() => controls.pause(id)}>暂停</button>}
          {status === 'paused' && <button type="button" className="council-ctl" onClick={() => controls.resume(id, newLeader)}>继续</button>}
          <button
            type="button"
            className="council-ctl council-end"
            onClick={() => controls.stop(id, status === 'finalizing' ? 'abort' : 'finalize')}
          >结束</button>
        </div>
      )}

      {open && (
        <div className="council-body">
          {topicMsg && <UserRow msg={topicMsg} className="council-topic" />}
          {rounds.map(([r, list]) => {
            const grid = r === 1 ? list.filter(m => m.who === 'ai' && !isLeader(m.council?.seat) && (m.council?.stage === 'answer' || m.council?.stage === 'failed')) : []
            const rest = grid.length ? list.filter(m => !grid.includes(m)) : list
            return (
              <div className="council-round-sec" key={r} data-round={r}>
                <div className="council-divider" role="separator"><span className="line" /><span className="lbl">第 {r} 轮</span><span className="line" /></div>
                {grid.length > 0 && (
                  <div className="council-grid">
                    {grid.map(m => m.council?.stage === 'failed'
                      ? <div className="council-card failed" key={m.id} data-seat={m.council?.seat}><FailedChip msg={m} seat={seatOf(m)} /></div>
                      : <AnswerCard key={m.id} msg={m} seat={seatOf(m)} streaming={streamingIds.has(m.id)} />)}
                  </div>
                )}
                <Utterances list={rest} seatOf={seatOf} streamingIds={streamingIds} />
              </div>
            )
          })}
          {final && finalStreaming && <SummaryCard msg={final} seat={seatOf(final)} streaming />}
        </div>
      )}

      {final && !finalStreaming && (
        <CouncilResultCard
          final={final}
          topic={topic}
          chosen={state?.chosen}
          resultFile={state?.resultFile}
          seatLabel={seatLabel}
          onChoose={onChoose}
        />
      )}

      {open && followups.length > 0 && (
        <div className="council-body council-followups">
          <Utterances list={followups} seatOf={seatOf} streamingIds={streamingIds} />
        </div>
      )}

      {status === 'done' && state && (
        <div className="council-followup">
          <select value={target} disabled={busy} onChange={e => setTarget(e.target.value)}>
            <option value="all">全体</option>
            {state.config.seats.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <input
            value={q}
            disabled={busy}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void ask() } }}
          />
          <button type="button" className="council-ctl" disabled={busy || !q.trim()} onClick={() => void ask()}>追问</button>
        </div>
      )}
    </section>
  )
}
