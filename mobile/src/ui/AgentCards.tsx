import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import type { DelegateBatch, SubagentCard } from '../../../src/shared/types'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'
import {
  delegateSummary,
  delegateTone,
  latestStep,
  subagentBody,
  subagentSummary,
  subagentTitle,
  subagentTone,
  type Tone,
} from './agentParse'

/**
 * 子代理卡 / 委派批次卡 —— 沿用工具卡那一套版式(原型 `d.css` 的 `.tool` / `.th` / `.code`),
 * 因为它们在对话流里是同一类东西:**挂在这条回复下面的一步**,折叠一行、展开看细节。
 *
 * 为什么要它:主代理起了四个子代理去探查时,手机上原来只有一段思考和一个不动的光标。
 * 派出去几个、谁在跑、谁回来了 —— 一个都看不见。
 */

function dotColor(c: ReturnType<typeof useC>, tone: Tone) {
  return tone === 'run' ? c.accent : tone === 'err' ? c.err : c.ok
}

/** 折叠一行 + 展开一段。两种卡共用。 */
function Card({
  tone,
  title,
  right,
  note,
  body,
}: {
  tone: Tone
  title: string
  right?: string
  /** 折叠态第二行:它最近在做什么。空串就不画 —— 不编「正在工作…」。 */
  note?: string
  body: string
}) {
  const c = useC()
  const [open, setOpen] = useState(false)
  return (
    <View style={[st.card, { backgroundColor: c.surface, borderColor: tone === 'run' ? c.toolRunBorder : c.border }]}>
      <Pressable onPress={() => setOpen((v) => !v)} style={st.th} hitSlop={4}>
        <T style={[st.cv, { color: c.muted }]}>{open ? '▾' : '▸'}</T>
        <View style={[st.dot, { backgroundColor: dotColor(c, tone) }]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T numberOfLines={1} style={[st.title, { color: c.fg2 }]}>
            {title}
          </T>
          {note ? (
            <T numberOfLines={1} style={[st.note, { color: c.faint }]}>
              {note}
            </T>
          ) : null}
        </View>
        {/* ✗ 要和工具卡上的那个同色 —— 一个红一个灰,看起来像两种不同的失败。 */}
        {right ? <T style={[st.right, { color: tone === 'err' ? c.err : c.ok }]}>{right}</T> : null}
      </Pressable>
      {open ? (
        <T style={[st.body, { color: c.fg2, borderTopColor: c.border, backgroundColor: c.bg2 }]}>{body}</T>
      ) : null}
    </View>
  )
}

/** 这一轮主代理用 Task 起的内置子代理。落档在消息上,刷新还在。 */
export function SubagentCards({ cards }: { cards?: SubagentCard[] }) {
  const c = useC()
  if (!cards?.length) return null
  return (
    <View style={st.group}>
      <T style={[st.lead, { color: c.faint }]}>{subagentSummary(cards)}</T>
      {cards.map((s) => {
        const b = subagentBody(s)
        return (
          <Card
            key={s.id}
            tone={subagentTone(s.state)}
            title={subagentTitle(s)}
            note={s.state === 'running' ? latestStep(s) : ''}
            right={s.state === 'running' ? '' : s.state === 'error' ? '✗' : '✓'}
            body={b.text}
          />
        )
      })}
    </View>
  )
}

/**
 * `forge_delegate` 发出去的一批后台委派。**纯实时,不落档** ——
 * 主轮次早就结束了它们还在跑,这张卡是唯一看得见进度的地方,所以刷新之后就没了。
 */
export function DelegateCards({ batches }: { batches?: DelegateBatch[] }) {
  const c = useC()
  if (!batches?.length) return null
  return (
    <>
      {batches.map((b) => (
        <View key={b.runId} style={st.group}>
          <T style={[st.lead, { color: c.faint }]}>{delegateSummary(b)}</T>
          {b.task ? (
            <T numberOfLines={2} style={[st.task, { color: c.muted }]}>
              {b.task}
            </T>
          ) : null}
          {b.agents.map((a) => (
            <Card
              key={a.agentId}
              tone={delegateTone(a.status)}
              title={`${a.name} · ${a.provider}`}
              note={a.status === 'run' ? (a.activity ?? '') : ''}
              right={a.status === 'run' ? '' : a.status === 'idle' ? '✗' : '✓'}
              body={(a.output ?? '').trim() || (a.status === 'run' ? '还在跑,输出要等它结束' : '这个子代理没有回传内容')}
            />
          ))}
        </View>
      ))}
    </>
  )
}

const st = StyleSheet.create({
  // 和工具卡同一栏(原型的 26px 缩进)。
  group: { marginLeft: 26, gap: 6, marginBottom: 6 },
  lead: { fontFamily: MONO, fontSize: 11, letterSpacing: 0.3 },
  task: { fontSize: 12, lineHeight: 18 },
  card: { borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  th: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 11, paddingVertical: 9 },
  cv: { fontSize: 11, width: 11 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  title: { fontFamily: MONO, fontSize: 11.5, fontWeight: '600' },
  note: { fontFamily: MONO, fontSize: 10.5, marginTop: 2 },
  right: { fontSize: 11.5, fontWeight: '700' },
  body: { fontFamily: MONO, fontSize: 11, lineHeight: 18, padding: 10, borderTopWidth: StyleSheet.hairlineWidth },
})
