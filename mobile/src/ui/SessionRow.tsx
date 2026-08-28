import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useC } from '../theme/theme'
import { T } from './kit'
import { Icon } from './Icon'
import { HOME } from './homeGeom'
import { TREE } from './tree'
import { TreeConnector } from './TreeConnector'

/**
 * 工作区抽屉里的一条会话。**全出血**:左边 44pt 是树的连接列,右边一路铺到屏幕右沿。
 *
 * ★★为什么 Pressable 在**最外层**(把连接列也包进去):按下去的高亮必须覆盖整行,
 *  包括左边那 44pt 的树。只包内容区的话,按在树上没反应、按在文字上才有 —— 同一行两种行为。
 *
 * ★★分隔线绝对定位在**内容区**底部(`left:0 right:0 bottom:0`,而内容区的左沿正好是 44),
 *  **不能**当兄弟节点插在两行之间:那 0.5pt 的高度会在主干上每行切一个口子,一列扫下来
 *  主干看着像一条画坏了的虚线。理由完整版在 homeGeom.ts 的 `separatorInset`。
 *
 * ★这一层**没有任何纵向 margin**,而且它自己不带 onLayout —— 首页那三段 y 的第③段量的是
 *  它**外面**那个 wrapper。别把 onLayout 挪进来,也别在这一层外面再套一层。
 */
export function SessionRow({
  index, total, gate, onPress, children,
}: {
  /** 这是抽屉里第几条(从 0 起)。决定树画 `├─` 还是 `└─`。 */
  index: number
  /** 抽屉里一共几条。 */
  total: number
  gate?: boolean
  onPress: () => void
  children: React.ReactNode
}) {
  const c = useC()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        st.row,
        { backgroundColor: gate ? c.gateRowBg : c.surface },
        pressed && { backgroundColor: c.surface2 },
      ]}
    >
      <TreeConnector index={index} total={total} />
      <View style={st.body}>
        {children}
        <View style={[st.sep, { backgroundColor: c.border }]} />
      </View>
    </Pressable>
  )
}

/**
 * 「＋ 新建会话」这类**添加行** —— iOS 列表里那种蓝字的一行。
 *
 * ★★它替掉了原来那颗虚线描边的 ghost 按钮。旧规矩是「造一个还不存在的东西 = 虚线」,
 *  那条规矩在全出血列表里没有位置(虚线框需要边距才立得住),已经作废 ——
 *  `app/index.tsx` 里那两段解释虚线的长注释要一并删掉,别留一条已经不成立的规矩误导下一个人。
 *  (顺带治了旧做法的一个真毛病:RN 的 `borderStyle: 'dashed'` 在 Android 上一旦有圆角
 *   就退回实线,所以那颗按钮在安卓上从来就不是虚线。)
 *
 * ★`deep` = 站在会话那一档(左边留出 44pt 的空连接列,文字左沿和会话标题对齐)。
 *  ★★**这 44pt 必须是一个真的 View,不能用 paddingLeft**:`e2e/tree.mjs` 量的是
 *  「从文字往上走、第一个高度 ≥32 的祖先的 left」—— 用 padding 的话量到的是整行(left=0),
 *  那条「和会话卡左沿对齐」的断言会红。用空 View 撑,量到的就是 44。
 *
 * ★它**不上树**:那 44pt 里一根线都不画。树说的是「这几条从属于上面那个工作区」,连的是
 *  **已经存在**的东西;这一行是「造一个还不存在的」。而且主干由最后一条会话收住(`trunkAt`),
 *  主干越过它伸到这一行上,收尾的 `└─` 就落在一个动作上了。理由完整版在 `tree.ts`。
 */
export function ActionRow({
  icon, onPress, disabled, deep, last, children,
}: {
  icon: 'add'
  onPress: () => void
  disabled?: boolean
  /** 站在会话那一档(左边空出 44pt)。false = 站在工作区那一档。 */
  deep?: boolean
  /** 这一行是一个区块的收尾 —— 底下那条分隔线画满整宽,把区块封住。 */
  last?: boolean
  children: React.ReactNode
}) {
  const c = useC()
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => [
        st.action,
        { backgroundColor: c.surface },
        pressed && { backgroundColor: c.surface2 },
        disabled && { opacity: 0.42 },
      ]}
    >
      {deep ? <View style={{ width: TREE.col }} /> : null}
      <View style={st.actionBody}>
        <Icon name={icon} size={15} color={c.accent} />
        <T style={{ fontSize: 15, color: c.accent }}>{children}</T>
        <View style={[st.sep, last ? { left: -(deep ? TREE.col : 0) } : null, { backgroundColor: c.border }]} />
      </View>
    </Pressable>
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  body: {
    flex: 1,
    minWidth: 0,
    minHeight: HOME.minDeepRowH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingRight: HOME.rowInsetX,
    paddingVertical: 9,
  },
  action: { flexDirection: 'row', alignItems: 'stretch' },
  actionBody: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: HOME.rowInsetX,
    paddingLeft: 0,
  },
  /** ★零布局影响:绝对定位不占纵向空间,不会去动首页那三段 onLayout 的 y。 */
  sep: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
})
