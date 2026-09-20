import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'
import { StatusBadge } from './StatusBadge'
import type { SessionTier } from '../data/sessionStatus'
import { foldA11yLabel, foldCaret, needsYouView } from './needsYouView'
import { loadNeedsYouFolded, saveNeedsYouFolded } from '../data/needsYouFold'

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
 *
 * ★★**可以折叠,但折的只有列表,头永远在。**(用户在几个折法里点的名就是这一版。)
 *  事多的时候这一块能顶掉大半屏,把下面「全部工作区」整个挤出视野;但**它绝不能整块消失** ——
 *  头上那句「4 条等你 · 2 道门」是上面那条承诺的落点:折起来之后你仍然看得见**有事**、
 *  有**几件**、其中**几道门**,只是看不见分别是哪几条。一个能把挂着的门整个藏起来的折叠,
 *  会把「没有这一块 = 没你的事」直接变成谎话 —— 那是这个 app 唯一不能出的错。
 *  这条规矩落在 `needsYouView.ts`(node 下有单测),不是靠这里的 JSX 自觉。
 * ★折叠状态存盘(`mff.needsYouFolded.v1`,和工作区展开态同一套存法):折叠是**姿态**,
 *  每次冷启动都替人重新展开一遍,等于这个开关根本没做完。
 */
export function NeedsYou({ items, gateCount, onPick }: {
  items: NeedItem[]
  /** 标题里那个「N 道门」。门和「在跑 / 未读」不是一回事,值得单独报数。 */
  gateCount: number
  onPick: (it: NeedItem) => void
}) {
  const c = useC()
  // ★默认展开。读盘是异步的,这几百毫秒里先按展开画 —— 反过来(先按折叠画)会让
  //  冷启动那一下把门闪没,而这一块就是给门用的。存储读不出来也一律展开(见 needsYouFold.ts)。
  const [folded, setFolded] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      const v = await loadNeedsYouFolded()
      if (alive && v) setFolded(true)
    })()
    return () => { alive = false }
  }, [])

  const v = needsYouView(items.length, gateCount, folded)
  if (!v.render) return null
  const toggle = () => {
    setFolded((f) => {
      const n = !f
      void saveNeedsYouFolded(n)
      return n
    })
  }
  return (
    <View style={[st.wrap, { backgroundColor: c.surface, borderColor: c.gateBorder }]}>
      {/* ★★整条头都是开关(热区横跨整块宽度)。只让那个三角可点的话,手指多半落在旁边的
          实底琥珀上,现象是「点了没反应」—— 这套代码已经在别处栽过好几次同一件事。 */}
      <Pressable
        onPress={toggle}
        // ★★这里**不能靠 hitSlop**,必须是真的内边距(见 st.head 的 paddingVertical)。
        //  第一版写的是 `hitSlop={{top:6,bottom:6}}` 并注释「撑到 46,布局一点没变」——
        //  那句话是假的:外面 `st.wrap` 带 `overflow:'hidden'`,而这一条是它的第一个子节点,
        //  多出来的 6pt 全落在容器外面,被裁掉。更根本的是 Fabric 的命中测试:祖先紧贴子节点时
        //  (`overflowInset == {}`)边界外的点会被直接拒掉,而 **hitSlop 不写进 overflowInset**。
        //  同一条把「复制」按钮变成了 22×13pt 的死区,人以为剪贴板坏了 —— 其实是根本没点中。
        //  ★结论:hitSlop 只在**祖先宽裕**的地方成立(比如输入区里那颗 ⤢);祖先紧的地方只能加 padding。
        accessibilityRole="button"
        accessibilityLabel={foldA11yLabel(folded, items.length, gateCount)}
        style={({ pressed }) => [st.head, { backgroundColor: c.gate }, pressed && { opacity: 0.82 }]}
      >
        {/* ★数在**头**上,所以折起来也还在。别把它挪进下面那个列表里。 */}
        <T style={{ flex: 1, fontSize: 12, fontWeight: '700', color: c.onGate }}>❓ {v.head}</T>
        {/* ▾ / ▸ 和工作区分组头是同一套字形(见 kit.tsx 的 `Sec`),别在这儿另发明一套。
            颜色用 onGate:这一条底是实心琥珀,普通 faint 灰在上面根本看不见。 */}
        <T style={{ fontSize: 11, color: c.onGate }}>{foldCaret(folded)}</T>
      </Pressable>
      {items.slice(0, v.rows).map((it, i) => (
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
  // ★收起时这一条就是整块的全部,所以它得自己站得住:横排、三角在最右。
  // ★收起时这一条就是整块的全部,所以它得自己站得住;paddingVertical 14 = 一行 ~17pt 字撑到 45pt,
  //  压过 44 的最小触达。★这 14 是**触达要求**,不是留白品味 —— 别「顺手收紧」回 9。
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, paddingVertical: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, paddingVertical: 11 },
  pip: { width: 7, height: 7, borderRadius: 4 },
})
