import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'
import type { Gate } from '../data/store'

/** 等待时长 mm:ss。门等得越久越该显眼 —— 这个数字就是「我卡了多久」。 */
export function useWaited(since: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/**
 * 门。**全屏唯一的实底彩色块**,钉在输入区正上方,不参与滚动。
 *
 * 这是整个手机端存在的理由:代理停在门上,而你不在电脑前。所以它:
 *   - 用琥珀实底(不是边框、不是浅底),周围一切保持中性;
 *   - 不跟着消息流滚走 —— 在消息流里它会被后续输出推出视野(那正是原型 A 版被否掉的原因);
 *   - 断线时按钮全禁用并说明原因,不假装能答。
 */
export function GateCard({
  gate,
  index,
  total,
  online,
  where,
  perm,
  onAllow,
  onDeny,
  onOpen,
}: {
  gate: Gate
  index: number
  total: number
  online: boolean
  /** 「位置」那一行:工作区 · 会话 */
  where: string
  /** 「权限档」那一行。这是本机的当前选择,不是服务端给的 —— 它决定了「允许」之后代理能动多少。 */
  perm?: string
  onAllow: () => void
  onDeny: () => void
  onOpen: () => void
}) {
  const c = useC()
  const waited = useWaited(gate.since)
  const pg = total > 1 ? `门 ${index + 1} / ${total}` : ''
  const isConfirm = gate.kind === 'confirm'

  const head = (
    <View style={st.head}>
      <T mono style={[st.headText, { color: c.onGate }]}>
        {isConfirm ? '执行确认' : '代理在问你'} · 等待 {waited}
      </T>
      {pg ? (
        <T mono style={[st.headText, { color: c.onGate, marginLeft: 'auto' }]}>
          {pg}
        </T>
      ) : null}
    </View>
  )

  return (
    <View style={[st.card, { backgroundColor: c.gate }]}>
      {isConfirm ? (
        <>
          {head}
          <View style={st.body}>
            <T style={[st.title, { color: c.onGate }]}>{gate.title || '代理请求执行'}</T>
            {gate.where ? (
              <View style={[st.cmd, { backgroundColor: c.onGate12 }]}>
                <T style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 19, color: c.onGate }}>{gate.where}</T>
              </View>
            ) : null}
            <T style={[st.meta, { color: c.onGate }]}>
              位置 {where}
              {perm ? `\n权限档 ${perm}` : ''}
            </T>
          </View>
          <View style={st.acts}>
            <Pressable
              onPress={onDeny}
              disabled={!online}
              style={({ pressed }) => [
                st.btn,
                { backgroundColor: c.onGate14 },
                pressed && { opacity: 0.75 },
                !online && { opacity: 0.4 },
              ]}
            >
              <T style={[st.btnText, { color: c.onGate }]}>拒绝</T>
            </Pressable>
            <Pressable
              onPress={onAllow}
              disabled={!online}
              style={({ pressed }) => [
                st.btn,
                { backgroundColor: c.onGate },
                pressed && { opacity: 0.85 },
                !online && { opacity: 0.4 },
              ]}
            >
              <T style={[st.btnText, { color: c.gate }]}>允许执行</T>
            </Pressable>
          </View>
        </>
      ) : (
        <Pressable onPress={onOpen} disabled={!online} style={({ pressed }) => [pressed && { opacity: 0.9 }]}>
          {head}
          <View style={st.body}>
            <T style={[st.title, { color: c.onGate }]}>
              {gate.questions?.[0]?.question || gate.title || '代理在等你拿主意'}
            </T>
            <T style={[st.meta, { color: c.onGate }]}>
              {gate.kind === 'questions'
                ? `${gate.questions?.length ?? 0} 道题 · 答完代理立刻继续`
                : gate.options?.length
                  ? `${gate.options.length} 个选项 · 每个都有代价说明`
                  : '需要你写一句话'}
            </T>
          </View>
          <View style={st.acts}>
            <View style={[st.btn, { backgroundColor: c.onGate }, !online && { opacity: 0.4 }]}>
              <T style={[st.btnText, { color: c.gate }]}>去回答</T>
            </View>
          </View>
        </Pressable>
      )}
      {!online ? (
        <View style={[st.offline, { backgroundColor: c.onGate12 }]}>
          <T style={{ fontSize: 11.5, color: c.onGate }}>未连接 · 答不了。恢复连接后这道门还在。</T>
        </View>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  card: { borderRadius: RADIUS.gate, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, paddingTop: 9 },
  headText: { fontSize: 11, letterSpacing: 0.5, opacity: 0.82 },
  body: { paddingHorizontal: 13, paddingTop: 5, paddingBottom: 10 },
  title: { fontSize: 16.5, fontWeight: '700', letterSpacing: -0.3 },
  cmd: { marginTop: 7, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10 },
  meta: { marginTop: 7, fontSize: 11.5, lineHeight: 18, opacity: 0.82 },
  acts: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingBottom: 10 },
  btn: { flex: 1, minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 15, fontWeight: '700' },
  offline: { paddingHorizontal: 13, paddingVertical: 7 },
})
