import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'
import { tileColor, tileLabel } from './wsTile'

/**
 * 工作区一行。**它是一张分组表里的一行,不是一个小标题。**
 *
 * ★★为什么不用 `Sec`:`Sec`(原型 `d.css` 的 `.sec`)是 10.5px 的浅灰等宽小标签,
 *  原型里它永远只是「一行标签 + 底下一串 `.row` 卡片」里的那行标签 —— **从属标签,自己不可点**。
 *  二期给工作区加折叠时把这个标签变成了可点的主体、还默认收起,于是整屏只剩十几行浅灰小字。
 *  用户在真机上的原话是「非常简陋,非常丑」,根因不是配色,是**把标签当成了主体**。
 *  `Sec` 本身没动 —— 另外 6 个屏还在拿它当真正的分节标签用。
 *
 * ★版式是拿真数据渲染出五版让用户选的结果(V5 顶部「需要你」+ V4 分组表 + V3 色块):
 *  整组工作区收在**一个**圆角容器里、行与行之间用分隔线,而不是十张各自飘着的卡 ——
 *  「不素」靠的是结构,不是上色。原型第三条原则写死了「屏幕上唯一的实底彩色块是门」,
 *  色块是用户知情后**特批**的唯一例外,而且只承载身份(见 `wsTile.ts`),不承载状态。
 *
 * ★圆角靠 `first`/`last` 两个 prop 画在**行**上,而不是给整组套一个 `overflow:hidden` 的容器 ——
 *  容器会在渲染链条里多插一层,而 `app/index.tsx` 的定位气泡靠三段 `onLayout` 的 y 相加定位,
 *  多一层就得多测一段(那个文件里写着「重新嵌套要记得改三处」)。视觉一样,测量链条不动。
 */
export function WsRow({
  name, note, meta, expanded, gate, first, last, right, onPress, onLongPress,
}: {
  name: string
  /** 当前分支。★**不大写** —— git 的 ref 区分大小写,`FEAT/RMH-DAEMON` 是个不存在的分支名。 */
  note?: string
  /** 副行右半段:`N 个项目` 之类。 */
  meta?: string
  expanded: boolean
  /** 这个工作区里有门在等 —— 整行染琥珀。收起时也必须一眼看见,那是这一屏存在的理由。 */
  gate?: boolean
  first?: boolean
  last?: boolean
  right?: React.ReactNode
  onPress: () => void
  /** 长按呼出操作单(置顶 / 归档)。手机上没有右键。 */
  onLongPress?: () => void
}) {
  const c = useC()
  const sub = [note, meta].filter(Boolean).join(' · ')
  const label = tileLabel(name)
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={({ pressed }) => [
        st.row,
        {
          backgroundColor: gate ? c.gateRowBg : c.surface,
          borderColor: c.border,
          // 只有第一行画上边框、最后一行画下边框,中间靠各自的上边框当分隔线 —— 拼出「一个容器」。
          borderTopWidth: first ? StyleSheet.hairlineWidth : StyleSheet.hairlineWidth,
          borderBottomWidth: last ? StyleSheet.hairlineWidth : 0,
          borderTopLeftRadius: first ? RADIUS.panel : 0,
          borderTopRightRadius: first ? RADIUS.panel : 0,
          borderBottomLeftRadius: last ? RADIUS.panel : 0,
          borderBottomRightRadius: last ? RADIUS.panel : 0,
        },
        pressed && { backgroundColor: c.surface2 },
      ]}
    >
      <View style={[st.tile, { backgroundColor: tileColor(name) }]}>
        {/* 4 个字符时小一号 —— 34px 的方块放不下 4 个 13px 的等宽字。 */}
        <T style={{ fontFamily: MONO, fontSize: label.length > 2 ? 10 : 13, fontWeight: '600', color: '#fff' }}>
          {label}
        </T>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
          {name}
        </T>
        {sub ? (
          <T numberOfLines={1} style={{ fontFamily: MONO, fontSize: 11.5, color: c.muted, marginTop: 2 }}>
            {sub}
          </T>
        ) : null}
      </View>
      {/* ★徽章绝不让位:标题和副行都 numberOfLines={1} + minWidth:0 先缩,
          否则一个长区名(再叠上「大」字号)会把「❓ 等你答话」整个顶出屏幕。 */}
      {right}
      <T style={{ fontSize: 11, color: c.faint }}>{expanded ? '▾' : '›'}</T>
    </Pressable>
  )
}

const st = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    minHeight: 58,
    paddingVertical: 9,
    paddingHorizontal: 13,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  tile: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
})
