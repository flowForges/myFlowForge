import { StyleSheet, View } from 'react-native'
import { useC } from '../theme/theme'
import { TREE, elbowWidth, trunkAt } from './tree'

/**
 * 会话行左边那一列树枝:中间的是 `├─`,最后一条是 `└─`(主干到此为止)。
 * 数和「为什么是这几个数」在 `tree.ts`,那边有单测;这里只负责把它们画出来。
 *
 * ★★**列内一律绝对定位,一个高度都不问。**
 *  这一层拿不到行高:node/jsdom 环境测不了布局,而 Fabric 下的原生测量 API 这个环境
 *  没法验证(见 `app/index.tsx` 的 `absY()` 注释,那边为了同一个理由绕开了 measureLayout)。
 *  所以:连接列**定宽**、竖线 `top:0 → bottom:0`(最后一条改成 `height:'50%'`)、
 *  横杠挂在 `top:'50%'` —— 拐角自然落在这一行的垂直中点上,行有多高完全不影响对齐。
 *  ★连接列本身不设高度,靠 flex 的 `stretch` 长到和卡片一样高;
 *   千万别给它加纵向 margin/padding,那会让 `50%` 不再是卡片的中点。
 */
export function TreeConnector({ index, total }: { index: number; total: number }) {
  const c = useC()
  const stop = trunkAt(index, total) === 'stop'
  return (
    <View style={st.col}>
      {/* ★颜色用 `border2` 而不是 `border`:电脑端那条线躺在一片纯色侧栏上,而这棵树躺在抽屉的
          `bg2` 里、四周还围着一圈 `border` 的描边 —— 同一档颜色在这儿会被周围的框吃掉,
          远看又变回「有根淡淡的竖线」。用户否掉的正是那个观感。 */}
      <View style={[st.trunk, stop ? st.trunkStop : st.trunkThrough, { backgroundColor: c.border2 }]} />
      <View style={[st.elbow, { backgroundColor: c.border2 }]} />
    </View>
  )
}

/**
 * 两张会话卡之间那道缝里的一小段主干。
 *
 * ★没有它,主干就是**虚的**:卡片之间隔着 `TREE.rowGap`,而每一行的连接列只有卡片那么高,
 *  于是竖线每隔一张卡就断一次,看着像一条画坏了的虚线。这一段把它接上。
 * ★它画在**每一行 wrapper 的最上面**(包括第一行)—— 第一行也画,主干才是从抽屉的上沿、
 *  也就是紧贴着工作区那一行往下长出来的。第一行不画的话,工作区和树之间会空一截,
 *  「连不上」这个毛病就又回来了。
 */
export function TreeGap() {
  const c = useC()
  return <View style={[st.gap, { backgroundColor: c.border2 }]} />
}

const st = StyleSheet.create({
  col: { width: TREE.col },
  trunk: { position: 'absolute', left: TREE.trunk, top: 0, width: TREE.line },
  trunkThrough: { bottom: 0 },
  /** 最后一条:主干只画到中点,和横杠交汇处收住 —— 这就是 `└`。 */
  trunkStop: { height: '50%' },
  elbow: { position: 'absolute', left: TREE.trunk, top: '50%', width: elbowWidth(), height: TREE.line },
  gap: { height: TREE.rowGap, width: TREE.line, marginLeft: TREE.trunk },
})
