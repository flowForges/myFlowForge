import { Pressable, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'
import { StatusBadge } from './StatusBadge'
import type { SessionTier } from '../data/sessionStatus'

export type NeedItem = {
  key: string
  wsPath: string
  sessionId: string
  /** 会话标题 */
  title: string
  /** 副行:`工作区 · 代理 · 等了 03:12` 之类,由调用方拼好 */
  sub: string
  tier: Exclude<SessionTier, 'idle'>
}

/**
 * 顶部「需要你」——**这一屏存在的理由**。
 *
 * 手机端的全部意义是「代理停在门上而你不在电脑前」(设计文档 §1.1)。可一期/二期做完之后,
 * 这件事是靠**扫视整列工作区上的徽章**得到的:门在哪个区、等了多久,得自己拼。
 * 这一块把它直接摊开:有几件事等你、分别是什么、等了多久,一眼看完。
 *
 * ★为什么允许它是实底琥珀:原型第三条原则说「屏幕上唯一的实底彩色块是门」——
 *  这一条**就是门**(只是把散在各处的门聚了个头),所以不算破例。
 *  ★但它只在**真有事**的时候出现:没事的时候整块不渲染,不留一个「0 条等你」的空壳。
 *   「没有这一块 = 没你的事」和定位气泡是同一个承诺。
 *
 * ★和下面工作区行上的徽章**是重复的** —— 这是有意的取舍,用户在五个方案里选的就是这一版:
 *  上面回答「有没有我的事」,下面回答「这个区是什么状况」,两个问题都要答。
 */
export function NeedsYou({ items, gateCount, onPick }: {
  items: NeedItem[]
  /** 标题里那个「N 道门」。门和「在跑 / 未读」不是一回事,值得单独报数。 */
  gateCount: number
  onPick: (it: NeedItem) => void
}) {
  const c = useC()
  if (!items.length) return null
  const head = gateCount > 0
    ? `${items.length} 条等你 · ${gateCount} 道门`
    : `${items.length} 条等你`
  return (
    <View style={[st.wrap, { backgroundColor: c.surface, borderColor: c.gateBorder }]}>
      <View style={[st.head, { backgroundColor: c.gate }]}>
        <T style={{ fontSize: 12, fontWeight: '700', color: c.onGate }}>❓ {head}</T>
      </View>
      {items.map((it, i) => (
        <Pressable
          key={it.key}
          onPress={() => onPick(it)}
          style={({ pressed }) => [
            st.row,
            { borderTopColor: c.border, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth },
            pressed && { backgroundColor: c.surface2 },
          ]}
        >
          <View
            style={[
              st.pip,
              { backgroundColor: it.tier === 'gate' ? c.gate : it.tier === 'running' ? c.ok : c.accent },
            ]}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T numberOfLines={1} style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>
              {it.title}
            </T>
            <T numberOfLines={1} style={{ fontFamily: MONO, fontSize: 11.5, color: c.muted, marginTop: 2 }}>
              {it.sub}
            </T>
          </View>
          <StatusBadge tier={it.tier} />
        </Pressable>
      ))}
    </View>
  )
}

const st = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginTop: 10,
    borderRadius: RADIUS.panel,
    borderWidth: 1,
    overflow: 'hidden',
  },
  head: { paddingHorizontal: 13, paddingVertical: 9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, paddingVertical: 11 },
  pip: { width: 7, height: 7, borderRadius: 4 },
})
