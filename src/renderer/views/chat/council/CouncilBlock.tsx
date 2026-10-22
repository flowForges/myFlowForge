import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage, ProviderInfo } from '@shared/types'
import { isCouncilProvider, type CouncilSeat, type CouncilState } from '@shared/council'
import type { CouncilApi } from '../../../state/useCouncil'
import { Markdown } from '../markdown'
import { ThinkBlock } from '../ThinkBlock'
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
const FALLBACK_SEAT: SeatInfo = { provider: '', label: '', color: SEAT_COLORS[0] }
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

const ZOOM = '⤢'

/** 发言自带的思考过程:统一叫「思考」,完成后默认收起;流式时展开并跟着滚。 */
function UtteranceThink({ msg, streaming }: { msg: ChatMessage; streaming: boolean }) {
  if (!msg.think || (!streaming && msg.think.steps.length === 0)) return null
  return <ThinkBlock think={msg.think} streaming={streaming} label="思考" follow />
}

/** 流式时正文区跟着滚到底;用户自己往上翻了就不再抢滚动条。 */
function useFollow(text: string, streaming: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (streaming && el && pinned.current) el.scrollTop = el.scrollHeight
  }, [text, streaming])
  const onScroll = () => {
    const el = ref.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  return { ref, onScroll }
}

/**
 * 网格里的一格 = 一位席位在一轮里的一次发言(回答 / 点评 / 投票 / 失败)。
 * ★全文直接画出来,格子内部滚动(不再截断再「展开」)—— 用户要逐轮看全每个 AI 的输出。
 */
const Cell = memo(function Cell({ msg, seat, streaming, onFocus }: { msg: ChatMessage; seat: SeatInfo; streaming: boolean; onFocus: (id: string) => void }) {
  const stage = msg.council?.stage
  const follow = useFollow(msg.text, streaming)
  if (stage === 'failed') {
    return <div className="council-cell failed" data-seat={msg.council?.seat} data-stage={stage}><FailedChip msg={msg} seat={seat} /></div>
  }
  const vote = stage === 'consensus-vote' ? (streaming ? 'unknown' : voteOf(msg.text)) : null
  return (
    <div className={`council-cell${streaming ? ' live' : ''}`} data-seat={msg.council?.seat} data-stage={stage} style={{ '--seat': seat.color } as React.CSSProperties}>
      <div className="council-who-line">
        <Logo id={seat.provider} /><span className="council-who-label">{seat.label}</span>
        {vote && <span className="council-vote" data-vote={vote} data-seat={msg.council?.seat}>{vote === 'agree' ? '✓' : vote === 'disagree' ? '✕' : '…'}</span>}
        <button type="button" className="council-more council-zoom" aria-label="放大" onClick={() => onFocus(msg.id)}>{ZOOM}</button>
      </div>
      <UtteranceThink msg={msg} streaming={streaming} />
      <div ref={follow.ref} onScroll={follow.onScroll} className="council-cell-body msg-body ans">
        <Markdown text={msg.text} streaming={streaming} />{streaming && <span className="pending" />}
      </div>
    </div>
  )
})

/** 领导者(总结 / 共识草稿 / 流式中的最终结果):整行宽,挂在那一轮的格子下面。 */
const LeaderCard = memo(function LeaderCard({ msg, seat, streaming, onFocus }: { msg: ChatMessage; seat: SeatInfo; streaming: boolean; onFocus: (id: string) => void }) {
  const follow = useFollow(msg.text, streaming)
  if (msg.council?.stage === 'failed') {
    return <div className="council-failed-row" data-seat={msg.council?.seat}><FailedChip msg={msg} seat={seat} /></div>
  }
  return (
    <div className={`council-summary council-leader-card${streaming ? ' live' : ''}`} data-seat={msg.council?.seat} data-stage={msg.council?.stage}>
      <div className="council-who-line">
        <span aria-hidden="true">👑</span><Logo id={seat.provider} /><span className="council-who-label">{seat.label}</span>
        <button type="button" className="council-more council-zoom" aria-label="放大" onClick={() => onFocus(msg.id)}>{ZOOM}</button>
      </div>
      <UtteranceThink msg={msg} streaming={streaming} />
      <div ref={follow.ref} onScroll={follow.onScroll} className="council-cell-body msg-body ans">
        <Markdown text={msg.text} streaming={streaming} />{streaming && <span className="pending" />}
      </div>
    </div>
  )
})

/** 还没发言的席位:虚线占位,只有席位名。 */
function WaitingCell({ sid, seat }: { sid: string; seat: SeatInfo }) {
  return (
    <div className="council-cell waiting" data-seat={sid} style={{ '--seat': seat.color } as React.CSSProperties}>
      <div className="council-who-line"><Logo id={seat.provider} /><span className="council-who-label">{seat.label}</span></div>
    </div>
  )
}

/** ⤢ 放大:单条发言全尺寸。挂到 body 上 —— 不受区块的滚动 / 裁剪影响。 */
function FocusOverlay({ msg, seat, streaming, onClose }: { msg: ChatMessage; seat: SeatInfo; streaming: boolean; onClose: () => void }) {
  const leader = isLeader(msg.council?.seat)
  return createPortal(
    <div className="council-focus-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="council-focus" role="dialog" aria-modal="true" aria-label={seat.label} style={{ '--seat': seat.color } as React.CSSProperties}>
        <div className="council-who-line">
          {leader && <span aria-hidden="true">👑</span>}<Logo id={seat.provider} /><span className="council-who-label">{seat.label}</span>
          <button type="button" className="council-more council-zoom" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <UtteranceThink msg={msg} streaming={streaming} />
        <div className="council-focus-body msg-body ans"><Markdown text={msg.text} streaming={streaming} />{streaming && <span className="pending" />}</div>
      </div>
    </div>,
    document.body,
  )
}

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

const SeatRow = memo(function SeatRow({ msg, seat, streaming }: { msg: ChatMessage; seat: SeatInfo; streaming: boolean }) {
  return (
    <div className="council-fu-row" data-seat={msg.council?.seat} style={{ '--seat': seat.color } as React.CSSProperties}>
      <div className="council-who-line"><Logo id={seat.provider} /><span>{seat.label}</span></div>
      <div className="msg-body ans"><Markdown text={msg.text} streaming={streaming} />{streaming && <span className="pending" />}</div>
    </div>
  )
})

/** 追问段:结果卡片下面,按出现顺序逐条画。 */
function Followups({ list, seatOf, streamingIds }: {
  list: ChatMessage[]
  seatOf: (m: ChatMessage) => SeatInfo
  streamingIds: ReadonlySet<string>
}) {
  return <>{list.map(m => m.who === 'user'
    ? <UserRow key={m.id} msg={m} className="council-ask" />
    : m.council?.stage === 'failed'
      ? <div className="council-failed-row" key={m.id}><FailedChip msg={m} seat={seatOf(m)} /></div>
      : <SeatRow key={m.id} msg={m} seat={seatOf(m)} streaming={streamingIds.has(m.id)} />)}</>
}

/** 和引擎同一判法:连续失败两次即本场除名 —— 除名的席位当前轮不再画等待占位。 */
const DROP_AFTER_FAILURES = 2
function droppedSeats(messages: ChatMessage[]): Set<string> {
  const streak = new Map<string, number>()
  const out = new Set<string>()
  for (const m of messages) {
    const sid = m.council?.seat
    if (m.who !== 'ai' || !sid) continue
    const n = m.council?.stage === 'failed' ? (streak.get(sid) ?? 0) + 1 : 0
    streak.set(sid, n)
    if (n >= DROP_AFTER_FAILURES) out.add(sid)
  }
  return out
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
    return { topicMsg, rounds, final, followups: fu < 0 ? [] : messages.slice(fu) }
  }, [messages])
  const finalStreaming = !!final && streamingIds.has(final.id)

  // 列 = 席位,按配置顺序;没有状态快照时按消息里首次出现的顺序
  const columns = useMemo(() => {
    const cfg = state?.config.seats.map(s => s.id) ?? []
    const seen = [...seats.keys()].filter(k => !isLeader(k) && !cfg.includes(k))
    return [...cfg, ...seen]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey, seats])

  // ★当前轮还没开口的席位画虚线占位。轮间等用户时 state.round 已经是下一轮,那一轮还没开始 —— 不画
  const placeholderRound = state && !state.waitingForUser && (status === 'running' || status === 'paused') && !final ? state.round : 0
  const dropped = useMemo(() => droppedSeats(messages), [messages])
  const roundList = useMemo(() => {
    const list = [...rounds.keys()]
    if (placeholderRound && !rounds.has(placeholderRound)) list.push(placeholderRound)
    return list.sort((a, b) => a - b)
  }, [rounds, placeholderRound])

  // ⤢ 放大的那条发言(存 id:流式中它继续长)/ 整块全屏。Esc 先关放大,再退全屏。
  const [focusId, setFocusId] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const closeFocus = useCallback(() => setFocusId(null), [])
  useEffect(() => {
    if (!focusId && !fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (focusId) setFocusId(null)
      else setFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [focusId, fullscreen])
  const focusMsg = focusId ? messages.find(m => m.id === focusId) : undefined

  const ended = status ? !LIVE.has(status) : !!final && !finalStreaming
  // ★没点过就跟着状态走(进行中展开、结束后收起);点过一次就以用户为准,本次会话内保持
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = fullscreen || (userOpen ?? !ended)

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
  const [submitting, setSubmitting] = useState(false)
  // ★追问进行中:以引擎的 speaking 为准(追问的每位席位发言时都在里面),外加流式中的追问消息、
  //  和「已提交、IPC 还没回」那一下。不在界面里数回答 —— 数错一次输入框就永远锁死。
  const busy = submitting || (state?.speaking.length ?? 0) > 0 || followups.some(m => streamingIds.has(m.id))

  const ask = async () => {
    const text = q.trim()
    if (!text || busy) return
    setSubmitting(true)
    const ok = await controls.followup(id, text, target)
    setSubmitting(false)
    // ★失败(已弹提示)不清空,问题留在框里可以再发
    if (ok === false) return
    setQ('')
    setUserOpen(true)   // 追问的问答在区块里,收着就看不到
  }

  return (
    <section className={`council-block${open ? ' open' : ''}${fullscreen ? ' fullscreen' : ''}`} data-council={id} data-status={status}>
      <div className="council-headbar">
        <button type="button" className="council-head" aria-expanded={open} onClick={() => setUserOpen(!open)}>
          <span className="council-title">{header}</span>
          <span className="council-chev" aria-hidden="true">{EXPAND_ICON}</span>
        </button>
        <button
          type="button"
          className="council-more council-full"
          aria-label={fullscreen ? '退出全屏' : '全屏'}
          aria-pressed={fullscreen}
          onClick={() => setFullscreen(f => !f)}
        >{ZOOM}</button>
      </div>

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
          {roundList.map(r => {
            const list = rounds.get(r) ?? []
            const inter = list.filter(m => m.who === 'user')
            const leader = list.filter(m => m.who === 'ai' && isLeader(m.council?.seat))
            const bySeat = new Map<string, ChatMessage[]>()
            for (const m of list) {
              const sid = m.council?.seat
              if (m.who !== 'ai' || !sid || isLeader(sid)) continue
              bySeat.set(sid, [...(bySeat.get(sid) ?? []), m])
            }
            const cols = columns.filter(sid => bySeat.has(sid) || (r === placeholderRound && !dropped.has(sid)))
            return (
              <div className="council-round-sec" key={r} data-round={r}>
                <div className="council-divider" role="separator"><span className="line" /><span className="lbl">第 {r} 轮</span><span className="line" /></div>
                {inter.map(m => <UserRow key={m.id} msg={m} className="council-interject" />)}
                {cols.length > 0 && (
                  <div className="council-grid-scroll">
                    <div className="council-grid" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(260px, 1fr))` }}>
                      {cols.map(sid => {
                        const said = bySeat.get(sid)
                        const seat = seats.get(sid) ?? FALLBACK_SEAT
                        return (
                          <div className="council-col" key={sid} data-seat={sid}>
                            {said
                              ? said.map(m => <Cell key={m.id} msg={m} seat={seat} streaming={streamingIds.has(m.id)} onFocus={setFocusId} />)
                              : <WaitingCell sid={sid} seat={seat} />}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {leader.map(m => <LeaderCard key={m.id} msg={m} seat={seatOf(m)} streaming={streamingIds.has(m.id)} onFocus={setFocusId} />)}
              </div>
            )
          })}
          {final && finalStreaming && <LeaderCard msg={final} seat={seatOf(final)} streaming onFocus={setFocusId} />}
        </div>
      )}

      {focusMsg && <FocusOverlay msg={focusMsg} seat={seatOf(focusMsg)} streaming={streamingIds.has(focusMsg.id)} onClose={closeFocus} />}

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
          <Followups list={followups} seatOf={seatOf} streamingIds={streamingIds} />
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
