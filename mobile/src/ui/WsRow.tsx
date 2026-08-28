import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'
import { Icon } from './Icon'
import { HOME, separatorInset } from './homeGeom'
import { tileColor, tileLabel } from './wsTile'

/**
 * 工作区一行。**全出血** —— 贴着屏幕左右边缘,没有边距、没有圆角、没有左右描边。
 *
 * ★★2026-08-28 从「卡片」改成「全出血行」的理由,是用户在真机上的原话:
 *  「总感觉 app 是一个网页的感觉……顶部有顶栏,底部又是空的,工作区列表外包括顶栏是一样的颜色,
 *   而工作区是明显的白色,显得这是一个页面」。核实下来是字面事实:页面底 #f5f7f9、
 *  这一行 #ffffff,再加 12pt 边距和 13pt 圆角 —— 一块白板浮在灰框里,那是 web 的分层语言。
 *  微信的会话列表是全出血的:行的白就是这一屏的白。
 *
 * ★所以 `first` / `last` 两个 prop 删掉了:它们是用来画圆角、把一组行拼成「一个容器」的,
 *  而全出血之后**这一屏本身**就是那个容器,不需要再拼一个出来。
 *
 * ★★分隔线**绝对定位在行的底部**,不是当兄弟节点插在两行之间 —— 见 homeGeom.ts 的
 *  `separatorInset` 注释:插在中间会在下一层的树主干上每行切一个口子。这里虽然没有树,
 *  但两处必须用同一个做法,否则改一处忘一处。绝对定位还有一个好处:它不占纵向空间,
 *  不会去动首页那三段 onLayout 的 y。
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
  /** 这个工作区里有门在等 —— 整行染琥珀。★全出血之后它横贯整屏,比原来更抢眼,这是有意的。 */
  gate?: boolean
  right?: React.ReactNode
  onPress: () => void
  /** 长按呼出操作单(置顶 / 归档 / 重命名)。★左滑是主入口,长按是备份 + 无障碍路径,两条都留。 */
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
        { backgroundColor: gate ? c.gateRowBg : c.surface },
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
      <Icon name={expanded ? 'chevronDown' : 'chevron'} size={13} color={c.faint} />
      {/* ★绝对定位,零布局影响。left 用 separatorInset('ws') 而不是写死 16 —— 那个数和
          会话行那一档是**一对**,改一处必须一起改,写死就等于把它们拆开了。 */}
      <View style={[st.sep, { left: separatorInset('ws'), backgroundColor: c.border }]} />
    </Pressable>
  )
}

const st = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    minHeight: HOME.minRowH,
    paddingVertical: 12,
    paddingHorizontal: HOME.rowInsetX,
  },
  tile: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  sep: { position: 'absolute', right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
})
