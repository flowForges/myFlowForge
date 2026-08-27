import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'

/**
 * 工作区分组头。**它是一张卡,不是一个小标题。**
 *
 * ★★为什么单开这个件,而不是继续用 `Sec`:
 *  `Sec`(原型 `d.css` 的 `.sec`)是 10.5px 的浅灰等宽小标签,原型里它的用法永远是
 *  「一行标签 + 底下一串 `.row` 卡片」—— 它是**从属标签**,自己不可点。
 *  二期给工作区加了折叠之后,这个标签变成了**可点的主体**,而且默认收起 ⇒
 *  整屏就只剩十几行浅灰小字,一条真内容都没有。用户的原话是「非常简陋,非常丑」,
 *  而根因不是配色,是**把标签当成了主体**:你要点的东西,成了全屏最不显眼的东西。
 *
 * ★所以这里改回原型早就定好的那套语言 —— 和会话行 `Row` 同一套:
 *  `surface` 底 + 1px 边框 + `RADIUS.card` 圆角 + 54 高,区名 15px/600 用 `fg`(不再大写、不再等宽),
 *  分支名和项目数降到 12px 的副行(`.row .mt` 的位置),徽章仍在最右。
 *  收起来时它是一列**卡片**,不是一列文字。
 *
 * ★挂着门的工作区整张卡染琥珀(`gateRowBg` + `gateBorder`),和会话行的 `gate` 态同一个处理 ——
 *  「这一格在等你」在收起状态下也必须一眼看见,那是这一屏存在的理由。
 */
export function WsRow({
  name, note, meta, expanded, gate, right, onPress, onLongPress,
}: {
  name: string
  /** 当前分支。★**不大写** —— git 的 ref 区分大小写,`FEAT/RMH-DAEMON` 是个不存在的分支名。 */
  note?: string
  /** 副行右半段:`N 个项目` 之类。 */
  meta?: string
  expanded: boolean
  /** 这个工作区里有门在等 —— 整张卡染琥珀。 */
  gate?: boolean
  right?: React.ReactNode
  onPress: () => void
  /** 长按呼出操作单(置顶 / 归档)。手机上没有右键。 */
  onLongPress?: () => void
}) {
  const c = useC()
  const sub = [note, meta].filter(Boolean).join(' · ')
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={({ pressed }) => [
        st.card,
        { borderColor: gate ? c.gateBorder : c.border, backgroundColor: gate ? c.gateRowBg : c.surface },
        pressed && { backgroundColor: c.surface2, borderColor: c.border2 },
      ]}
    >
      {/* 展开箭头。放最左边、低对比度 —— 它说明「这一格还能打开」,不该和区名抢注意力。 */}
      <T style={{ fontSize: 11, color: c.faint, width: 12 }}>{expanded ? '▾' : '▸'}</T>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
          {name}
        </T>
        {sub ? (
          // ★副行整体不大写:分支名在这里面。等宽是为了让分支名和数字读起来稳。
          <T numberOfLines={1} style={{ fontFamily: MONO, fontSize: 11.5, color: c.muted, marginTop: 3 }}>
            {sub}
          </T>
        ) : null}
      </View>
      {/* ★徽章绝不让位:标题和副行都 numberOfLines={1} + minWidth:0 先缩,
          否则一个长区名(再叠上「大」字号)会把「❓ 等你答话」整个顶出屏幕。 */}
      {right}
    </Pressable>
  )
}

const st = StyleSheet.create({
  card: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 54,
    paddingVertical: 11,
    paddingHorizontal: 13,
    borderRadius: RADIUS.card,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
