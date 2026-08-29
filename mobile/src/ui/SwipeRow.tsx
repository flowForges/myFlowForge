import { useEffect, useRef } from 'react'
import { StyleSheet, Pressable, View } from 'react-native'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useC } from '../theme/theme'
import { T } from './kit'
import { tap } from './haptics'
import { claimSwipeOpen, releaseSwipeOpen, type SwipeHandle } from './swipeRegistry'

export type SwipeAction = {
  key: string
  label: string
  /** `danger` = 破坏性(删除 / 归档),红底。★调用方仍然要弹确认框,颜色不代替确认。 */
  tone: 'plain' | 'danger'
  onPress: () => void
}

/**
 * 左滑露出动作格。微信那个形状:整行往左推,右边露出一排彩色方块。
 *
 * ★★**这个组件必须放在带 `onLayout` 的 wrapper 的里面,不能套在外面。**
 *  首页的定位气泡靠三段 onLayout 的 y 相加定位,第③段量的正是每行外面那个 wrapper。
 *  在它外面再套一层,三段 y 就少算了新那一层的偏移 —— 症状是气泡稳定地滚偏一截,
 *  而且**一条测试都不会红**(布局在 node/jsdom 里量不了)。`app/(tabs)/index.tsx` 里
 *  那段注释说的是同一件事。
 *
 * ★`react-native-gesture-handler` 一直在 package.json 里、原生也链好了,但在这之前
 *  全项目一行没用过 —— 所以 `GestureHandlerRootView` 是这一轮才挂上的(`app/_layout.tsx`)。
 *  没挂它的话,左滑**静默**不响应(不报错、不警告)。
 *
 * ★RNGH 2.32 的 `ReanimatedSwipeable`(`react-native-gesture-handler/ReanimatedSwipeable`)
 *  真实签名是 `renderRightActions?: (progress, translation, swipeableMethods) => ReactNode`
 *  ——三个参数,不是零参。这里用不上那三样(不做跟手动画、按下就用 `swipeableMethods.close()`
 *  收回去,不需要自己算 progress),TS 允许回调声明得比接口少参数,`() => (...)` 合法。
 *
 * ★★2026-08-29 真机第六轮:**滑开一行,别的行不会自己收**。`ReanimatedSwipeable` 每一行
 *  各管各的,谁也不知道谁开着 —— 于是能同时滑开五行,五排动作格一起摊在列表上。
 *  微信/邮件那类列表全都是「开第二行时第一行自己收 / 点别处也收」。协调这件事的注册表在
 *  `swipeRegistry.ts`(带单测),这里只负责两头接线:滑开时认领、收起或卸载时放手。
 *  ★**卸载也要放手**:列表刷新、切工作区、归档掉这一行,都会在「开着」的状态下把它卸掉,
 *   注册表里留下一个指向已卸载组件的 handle,之后 `close()` 打在空处 —— 表现是「点哪儿都收不掉,
 *   而且屏幕上根本没有开着的行」,一个彻底说不通的状态。
 *
 * ★动作格宽 76、高度拉满(`alignItems: 'stretch'`)—— 76 是「删除」两个字加上左右呼吸位,
 *  同时远大于 44 的最小触达。全出血的行左滑露出的方块是贴着屏幕右沿的,
 *  这也是为什么这件事必须等首页改成全出血之后才做:带圆角和边距的卡片左滑,露出来的东西很怪。
 */
export function SwipeRow({ actions, children }: { actions: SwipeAction[]; children: React.ReactNode }) {
  const c = useC()
  const swipeRef = useRef<SwipeableMethods>(null)
  // ★handle 的**对象身份**就是注册表认人的凭据,所以必须整个生命周期只有一个:
  //  `useRef` 的初值只在第一次渲染时被采纳,后面每次渲染新建的那个对象会被丢掉。
  //  闭包里抓的是 `swipeRef`(它本身也是稳定的),不是某一次渲染的值。
  const handle = useRef<SwipeHandle>({ close: () => swipeRef.current?.close() }).current
  // 卸载时放手。★写在 hook 里,所以必须在下面那个 early return **之前** —— hook 不能有条件地调。
  useEffect(() => () => releaseSwipeOpen(handle), [handle])
  if (!actions.length) return <>{children}</>
  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      // 拖过这么多就算「要开」。默认值偏大,在一行 54pt 高的会话上手感是「滑不动」。
      rightThreshold={40}
      overshootRight={false}
      // 动作格推到位那一下轻震 —— 手势到位这类「有分量」的动作之一,不是普通点击。
      // 同时向注册表认领「现在开着的是我」,上一行会被它顺手收掉。
      onSwipeableWillOpen={() => { tap('swipeOpen'); claimSwipeOpen(handle) }}
      onSwipeableWillClose={() => releaseSwipeOpen(handle)}
      renderRightActions={(_progress, _translation, methods) => (
        <View style={st.actions}>
          {actions.map((a) => (
            <Pressable
              key={a.key}
              // ★先放手再 close():`close()` 会触发 onSwipeableWillClose,那条路也会放手,
              //  两条都做是幂等的(releaseSwipeOpen 比对身份)。这里显式放一次,是为了让
              //  「动作已经被点了」这件事立刻在注册表里成立,不依赖动画回调什么时候到。
              onPress={() => { releaseSwipeOpen(handle); methods.close(); a.onPress() }}
              style={({ pressed }) => [
                st.action,
                { backgroundColor: a.tone === 'danger' ? c.err : c.surface2 },
                pressed && { opacity: 0.8 },
              ]}
            >
              <T style={{ fontSize: 14, fontWeight: '600', color: a.tone === 'danger' ? '#fff' : c.fg }}>
                {a.label}
              </T>
            </Pressable>
          ))}
        </View>
      )}
    >
      {children}
    </ReanimatedSwipeable>
  )
}

const st = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'stretch' },
  action: { width: 76, alignItems: 'center', justifyContent: 'center' },
})
