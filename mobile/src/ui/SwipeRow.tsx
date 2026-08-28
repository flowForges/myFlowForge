import { StyleSheet, Pressable, View } from 'react-native'
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useC } from '../theme/theme'
import { T } from './kit'

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
 * ★动作格宽 76、高度拉满(`alignItems: 'stretch'`)—— 76 是「删除」两个字加上左右呼吸位,
 *  同时远大于 44 的最小触达。全出血的行左滑露出的方块是贴着屏幕右沿的,
 *  这也是为什么这件事必须等首页改成全出血之后才做:带圆角和边距的卡片左滑,露出来的东西很怪。
 */
export function SwipeRow({ actions, children }: { actions: SwipeAction[]; children: React.ReactNode }) {
  const c = useC()
  if (!actions.length) return <>{children}</>
  return (
    <ReanimatedSwipeable
      // 拖过这么多就算「要开」。默认值偏大,在一行 54pt 高的会话上手感是「滑不动」。
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={(_progress, _translation, methods) => (
        <View style={st.actions}>
          {actions.map((a) => (
            <Pressable
              key={a.key}
              onPress={() => { methods.close(); a.onPress() }}
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
