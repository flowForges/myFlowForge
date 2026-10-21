import React, { memo, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import type { CouncilState, CouncilStatus } from '../../../src/shared/council'
import type { Msg } from '../data/useChat'
import type { CouncilControls } from '../data/useCouncil'
import { councilHeader, isLeaderSeat, mmss, orderCandidates, splitCouncil, voteOf } from '../data/councilGroup'
import { useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { AgentBadge, Btn, T } from './kit'
import { Icon } from './Icon'
import { MessageBody } from './MessageBody'

/**
 * 一场 AI 共商在手机对话流里的独立区块(§6.4 / §6.6)。照电脑端 `council/CouncilBlock.tsx` 的行为:
 * 标题行 + 进行中的状态行(暂停 / 继续 / 结束)+ 各轮发言 + 共识结果卡片(候选 + 选定)。
 * ★和电脑端的差别只有这几处:第 1 轮答案上下排列(不是并排网格);没有追问输入、没有换领导者
 *  (继续 = 原样接着跑);没有复制 / 打开文件。
 * ★纯 JS:颜色走主题、图标走 `AgentBadge` 字形,不引任何原生依赖。
 */

type SeatInfo = { provider: string; label: string; color: string }

// 席位左侧色条:按席位在配置里的顺序取色。值对着电脑端那组 oklch 换成 hex(RN 不认 oklch)。领导者用强调色。
const SEAT_COLORS = ['#4f95e0', '#4fb06e', '#d39a3c', '#df6458', '#a27ad6', '#3fb0bf']
const LIVE = new Set<CouncilStatus>(['running', 'paused', 'finalizing'])
// 第 1 轮答案卡片收起时露出的高度(约 6 行正文)。
const CARD_CLAMP = 150
// 结论收起时露出的高度。
const CONCLUSION_CLAMP = 260
const LONG_CHARS = 600

const Chev = ({ open, color }: { open: boolean; color: string }) => (
  <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
    <Icon name="chevronDown" size={11} color={color} />
  </View>
)

function WhoLine({ seat, leader, right }: { seat: SeatInfo; leader?: boolean; right?: React.ReactNode }) {
  const c = useC()
  return (
    <View style={st.who}>
      {leader ? <T style={{ fontSize: 12 }}>👑</T> : null}
      <AgentBadge id={seat.provider} size={15} />
      <T mono numberOfLines={1} style={{ fontSize: 11, color: c.faint, flexShrink: 1 }}>
        {seat.label}
      </T>
      {right ? <View style={{ marginLeft: 'auto' }}>{right}</View> : null}
    </View>
  )
}

const SeatRow = memo(function SeatRow({ msg, seat }: { msg: Msg; seat: SeatInfo }) {
  return (
    <View style={[st.row, { borderLeftColor: seat.color }]}>
      <WhoLine seat={seat} />
      <MessageBody text={msg.text} streaming={msg.streaming} indent={0} />
    </View>
  )
})

const SummaryCard = memo(function SummaryCard({ msg, seat }: { msg: Msg; seat: SeatInfo }) {
  const c = useC()
  return (
    <View style={[st.card, { borderColor: c.border2, backgroundColor: c.bg2 }]}>
      <WhoLine seat={seat} leader />
      <MessageBody text={msg.text} streaming={msg.streaming} indent={0} />
    </View>
  )
})

/** 第 1 轮的答案卡片:默认只露开头(流式时露正在写的那几行),点 ⌄ 看全文。 */
const AnswerCard = memo(function AnswerCard({ msg, seat }: { msg: Msg; seat: SeatInfo }) {
  const c = useC()
  const [open, setOpen] = useState(false)
  return (
    <View style={[st.card, { borderColor: c.border2, borderLeftColor: seat.color, borderLeftWidth: 3 }]}>
      <WhoLine
        seat={seat}
        right={
          <Pressable accessibilityLabel={open ? '收起' : '展开'} hitSlop={10} onPress={() => setOpen((o) => !o)}>
            <Chev open={open} color={c.faint} />
          </Pressable>
        }
      />
      {/* ★流式时贴底对齐:收起状态下看到的是正在写的那几行,而不是一直停在开头(电脑端是卡片内滚到底) */}
      <View style={open ? null : [st.clamp, { maxHeight: CARD_CLAMP }, msg.streaming && { justifyContent: 'flex-end' }]}>
        <View style={{ flexShrink: 0 }}>
          <MessageBody text={msg.text} streaming={msg.streaming} indent={0} />
        </View>
      </View>
    </View>
  )
})

function FailedChip({ seat }: { seat: SeatInfo }) {
  const c = useC()
  return (
    <View style={[st.failed, { borderColor: c.border2 }]}>
      <AgentBadge id={seat.provider} size={14} />
      <T style={{ fontSize: 11.5, color: c.muted }}>{seat.label}</T>
      <T style={{ fontSize: 11.5, color: c.err }}>✕</T>
    </View>
  )
}

function UserRow({ msg }: { msg: Msg }) {
  const c = useC()
  return (
    <View style={[st.you, { backgroundColor: c.accentDim, borderColor: c.youBorder }]}>
      <T style={{ fontSize: 14.5, lineHeight: 22, color: c.fg }}>{msg.text}</T>
    </View>
  )
}

function Divider({ round }: { round: number }) {
  const c = useC()
  return (
    <View style={st.divider}>
      <View style={[st.line, { backgroundColor: c.border }]} />
      <T mono style={{ fontSize: 10.5, color: c.faint }}>第 {round} 轮</T>
      <View style={[st.line, { backgroundColor: c.border }]} />
    </View>
  )
}

/** 一轮里的发言(第 1 轮答案卡片之外):逐条按出现顺序画,连续的投票收成一排徽标。 */
function Utterances({ list, seatOf }: { list: Msg[]; seatOf: (m: Msg) => SeatInfo }) {
  const c = useC()
  const out: React.ReactNode[] = []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const stage = m.council?.stage
    if (stage === 'consensus-vote') {
      const votes: Msg[] = []
      while (i < list.length && list[i].council?.stage === 'consensus-vote') votes.push(list[i++])
      i--
      out.push(
        <View key={`v-${m.id}`} style={st.votes}>
          {votes.map((v) => {
            const vote = v.streaming ? 'unknown' : voteOf(v.text)
            return (
              <View key={v.id} style={[st.vote, { borderColor: c.border2 }]}>
                <AgentBadge id={seatOf(v).provider} size={14} />
                <T style={{ fontSize: 12, color: vote === 'agree' ? c.ok : vote === 'disagree' ? c.err : c.faint }}>
                  {vote === 'agree' ? '✓' : vote === 'disagree' ? '✕' : '…'}
                </T>
              </View>
            )
          })}
        </View>,
      )
      continue
    }
    if (m.who === 'user') out.push(<UserRow key={m.id} msg={m} />)
    else if (stage === 'failed') out.push(<FailedChip key={m.id} seat={seatOf(m)} />)
    else if (stage === 'summary' || stage === 'consensus-draft' || stage === 'final')
      out.push(<SummaryCard key={m.id} msg={m} seat={seatOf(m)} />)
    else out.push(<SeatRow key={m.id} msg={m} seat={seatOf(m)} />)
  }
  return <>{out}</>
}

function Conclusion({ text }: { text: string }) {
  const c = useC()
  const long = text.length > LONG_CHARS || text.split('\n').length > 12
  const [open, setOpen] = useState(false)
  return (
    <View>
      <View style={long && !open ? [st.clamp, { maxHeight: CONCLUSION_CLAMP }] : null}>
        <MessageBody text={text} indent={0} />
      </View>
      {long ? (
        <Pressable accessibilityLabel={open ? '收起' : '展开'} hitSlop={8} onPress={() => setOpen((o) => !o)} style={st.more}>
          <Chev open={open} color={c.faint} />
        </Pressable>
      ) : null}
    </View>
  )
}

function ResultCard({
  final,
  chosen,
  online,
  seatLabel,
  onChoose,
}: {
  final: Msg
  chosen?: string
  online: boolean
  seatLabel: (id: string) => string
  onChoose: (name: string) => void
}) {
  const c = useC()
  const result = final.councilResult
  const candidates = useMemo(() => (result ? orderCandidates(result) : []), [result])
  const [tab, setTab] = useState(0)
  const cur = candidates[Math.min(tab, candidates.length - 1)]
  const rec = result?.recommended?.name
  return (
    <View style={[st.result, { borderColor: c.border2, backgroundColor: c.bg2 }]}>
      <Conclusion text={result ? result.conclusion : final.text} />

      {cur ? (
        <View style={{ marginTop: 10 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {candidates.map((cand, i) => {
              const on = cand === cur
              return (
                <Pressable
                  key={cand.name + i}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  onPress={() => setTab(i)}
                  style={[st.tab, { borderColor: on ? c.accent : c.border2, backgroundColor: on ? c.accentDim : 'transparent' }]}
                >
                  <T numberOfLines={1} style={{ fontSize: 12.5, fontWeight: on ? '600' : '500', color: on ? c.fg : c.muted }}>
                    {rec === cand.name ? '★ ' : ''}
                    {cand.name}
                    {chosen === cand.name ? ' ✓' : ''}
                  </T>
                </Pressable>
              )
            })}
          </ScrollView>
          <View style={{ marginTop: 8, gap: 6 }}>
            {cur.points ? <MessageBody text={cur.points} indent={0} /> : null}
            {cur.pros ? (
              <View style={st.pc}>
                <T style={{ fontSize: 13, color: c.ok, width: 16 }}>＋</T>
                <View style={{ flex: 1 }}>
                  <MessageBody text={cur.pros} indent={0} />
                </View>
              </View>
            ) : null}
            {cur.cons ? (
              <View style={st.pc}>
                <T style={{ fontSize: 13, color: c.err, width: 16 }}>－</T>
                <View style={{ flex: 1 }}>
                  <MessageBody text={cur.cons} indent={0} />
                </View>
              </View>
            ) : null}
            {cur.supporters.length ? (
              <View style={st.wrap}>
                {cur.supporters.map((s) => (
                  <T key={s} style={{ fontSize: 12, color: c.ok }}>
                    ✓ {seatLabel(s)}
                  </T>
                ))}
              </View>
            ) : null}
            {cur.dissenters.map((d, i) => (
              <T key={d.seat + i} style={{ fontSize: 12, lineHeight: 18, color: c.muted }}>
                <T style={{ color: c.err }}>✕ {seatLabel(d.seat)} </T>
                {d.reason}
              </T>
            ))}
            {rec === cur.name && result?.recommended?.reason ? (
              <T style={{ fontSize: 12.5, lineHeight: 19, color: c.fg2 }}>
                <T style={{ color: c.gate }}>★ </T>
                {result.recommended.reason}
              </T>
            ) : null}
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              <Btn size="sm" kind={chosen === cur.name ? 'pri' : 'default'} disabled={!online} onPress={() => onChoose(cur.name)}>
                {chosen === cur.name ? '✓ 选定' : '选定'}
              </Btn>
            </View>
          </View>
        </View>
      ) : null}

      {result && result.disagreements.length > 0 ? (
        <View style={{ marginTop: 10, gap: 4 }}>
          {result.disagreements.map((d, i) => (
            <T key={i} style={{ fontSize: 12, lineHeight: 18, color: c.muted }}>
              <T style={{ color: c.fg2 }}>{seatLabel(d.seat)} · </T>
              <T style={{ fontWeight: '600', color: c.fg2 }}>{d.point}</T>
              {d.reason ? `:${d.reason}` : ''}
            </T>
          ))}
        </View>
      ) : null}
    </View>
  )
}

export function CouncilBlock({
  id,
  messages,
  state,
  online,
  controls,
}: {
  id: string
  messages: Msg[]
  /** 状态快照可能比消息晚到;没有时只按消息画。 */
  state?: CouncilState
  online: boolean
  controls: CouncilControls
}) {
  const c = useC()
  const status = state?.status
  const live = !!status && LIVE.has(status)

  // 席位信息:优先用配置(颜色按配置顺序),消息里自带的 provider / model 兜底。
  // ★只在出现新席位时重算 —— 流式每一片都换 messages,SeatInfo 跟着换会让 memo 过的每一行都重渲染
  const seatKey = [...new Set(messages.map((m) => m.council?.seat).filter(Boolean))].join('|')
  const cfgKey = state ? [...state.config.seats, state.config.leader].map((s) => `${s.id}\u0001${s.provider}\u0001${s.label}`).join('|') : ''
  const seats = useMemo(() => {
    const map = new Map<string, SeatInfo>()
    state?.config.seats.forEach((s, i) => map.set(s.id, { provider: s.provider, label: s.label, color: SEAT_COLORS[i % SEAT_COLORS.length] }))
    if (state) map.set(state.config.leader.id, { provider: state.config.leader.provider, label: state.config.leader.label, color: c.accent })
    for (const m of messages) {
      const sid = m.council?.seat
      if (!sid || map.has(sid)) continue
      const n = [...map.keys()].filter((k) => !isLeaderSeat(k)).length
      map.set(sid, { provider: m.provider ?? '', label: m.model ?? sid, color: isLeaderSeat(sid) ? c.accent : SEAT_COLORS[n % SEAT_COLORS.length] })
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey, seatKey, c.accent])
  const seatOf = (m: Msg): SeatInfo =>
    seats.get(m.council?.seat ?? '') ?? { provider: m.provider ?? '', label: m.model ?? '', color: SEAT_COLORS[0] }
  const seatLabel = (sid: string) => seats.get(sid)?.label ?? sid

  const { topic: topicMsg, rounds, final, followups } = useMemo(() => splitCouncil(messages), [messages])
  const finalStreaming = !!final?.streaming

  const ended = status ? !live : !!final && !finalStreaming
  // ★没点过就跟着状态走(进行中展开、结束后收起);点过一次就以用户为准
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

  const header = councilHeader({
    topic: state?.config.topic ?? topicMsg?.text ?? '',
    seats: state?.config.seats.length ?? new Set(messages.map((m) => m.council?.seat).filter((s) => s && !isLeaderSeat(s))).size,
    rounds: state?.round || Math.max(0, ...messages.map((m) => m.council?.round ?? 0)),
    elapsedMs: elapsed,
  })

  return (
    <View style={[st.block, { borderColor: c.accent, backgroundColor: c.bg }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setUserOpen(!open)}
        style={st.head}
      >
        <T numberOfLines={1} style={{ flex: 1, fontSize: 12.5, fontWeight: '600', color: c.fg }}>
          {header}
        </T>
        <Chev open={open} color={c.muted} />
      </Pressable>

      {live && state ? (
        <View style={[st.status, { borderTopColor: c.border }]}>
          <T mono style={{ fontSize: 11, color: c.muted }}>
            {state.totalRounds ? `第 ${state.round} / ${state.totalRounds} 轮` : `第 ${state.round} 轮`}
          </T>
          <View style={{ flexDirection: 'row', gap: 3 }}>
            {state.speaking.map((sid) => (
              <AgentBadge key={sid} id={seats.get(sid)?.provider ?? ''} size={15} />
            ))}
          </View>
          <T mono style={{ fontSize: 11, color: c.faint }}>
            {mmss(elapsed)}
          </T>
          <View style={{ flex: 1 }} />
          {status === 'running' ? (
            <Btn size="sm" disabled={!online} onPress={() => void controls.pause(id)}>
              暂停
            </Btn>
          ) : null}
          {status === 'paused' ? (
            <Btn size="sm" disabled={!online} onPress={() => void controls.resume(id)}>
              继续
            </Btn>
          ) : null}
          {/* ★再点一次「结束」(已在 finalizing)= 不出结果直接终止 */}
          <Btn size="sm" kind="danger" disabled={!online} onPress={() => void controls.stop(id, status === 'finalizing' ? 'abort' : 'finalize')}>
            结束
          </Btn>
        </View>
      ) : null}

      {open ? (
        <View style={st.body}>
          {topicMsg ? <UserRow msg={topicMsg} /> : null}
          {rounds.map(([r, list]) => {
            const answers =
              r === 1
                ? list.filter(
                    (m) => m.who === 'ai' && !isLeaderSeat(m.council?.seat) && (m.council?.stage === 'answer' || m.council?.stage === 'failed'),
                  )
                : []
            const rest = answers.length ? list.filter((m) => !answers.includes(m)) : list
            return (
              <View key={r}>
                <Divider round={r} />
                {answers.map((m) =>
                  m.council?.stage === 'failed' ? (
                    <FailedChip key={m.id} seat={seatOf(m)} />
                  ) : (
                    <AnswerCard key={m.id} msg={m} seat={seatOf(m)} />
                  ),
                )}
                <Utterances list={rest} seatOf={seatOf} />
              </View>
            )
          })}
          {final && finalStreaming ? <SummaryCard msg={final} seat={seatOf(final)} /> : null}
        </View>
      ) : null}

      {final && !finalStreaming ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
          <ResultCard
            final={final}
            chosen={state?.chosen}
            online={online}
            seatLabel={seatLabel}
            onChoose={(name) => void controls.choose(id, name)}
          />
        </View>
      ) : null}

      {open && followups.length > 0 ? (
        <View style={st.body}>
          <Utterances list={followups} seatOf={seatOf} />
        </View>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  block: { marginTop: 14, borderWidth: 1.5, borderRadius: RADIUS.panel, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 11 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  body: { paddingHorizontal: 10, paddingBottom: 10 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  row: { marginTop: 10, paddingLeft: 9, borderLeftWidth: 3 },
  card: { marginTop: 8, padding: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.card },
  clamp: { overflow: 'hidden' },
  failed: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS.chip,
  },
  you: {
    marginLeft: 34,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 16,
    borderBottomRightRadius: 5,
    borderWidth: 1,
  },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  votes: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  vote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS.chip,
  },
  more: { alignSelf: 'center', paddingTop: 6 },
  result: { marginTop: 4, padding: 11, borderWidth: 1, borderRadius: RADIUS.card },
  tab: { paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderRadius: RADIUS.chip },
  pc: { flexDirection: 'row', alignItems: 'flex-start' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
})
