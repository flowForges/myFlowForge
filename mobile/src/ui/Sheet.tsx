import React, { useEffect } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'

/**
 * 底部抽屉。
 *
 * ★★2026-08-28 加了「跟手往下拖着关」。原来是 `Modal` + `animationType="slide"` ——
 *  滑出来就死在那儿。iOS 上任何一个 sheet 都能拖,拖不动是「这不是原生」最直接的证据,
 *  也是用户说的「总感觉是个网页」里说不出来的那一部分。
 *
 * ★`Modal` 外壳留着:它负责盖住底部那条 tab bar,并且接管 Android 的返回键(onRequestClose)。
 * ★只准往下拖(`Math.max(0, translationY)`)—— 往上拖会把面板拉出屏幕顶,底下露出一条缝。
 * ★★关闭判据是「位移过 1/4 **或** 速度 > 800」。只看位移的话,手指快速往下一甩、
 *  位移还不到 1/4 就松手 —— 那是最常见的关闭手势 —— 会被判成「弹回去」,感觉像卡住了。
 *
 * ★★手势只挂在把手 + 标题这一小条(`GestureDetector` 包的那个 `View`),不挂在整个面板。
 *  面板正文是 `ScrollView`,从正文里往下拖本来就有歧义(是滚动还是要关?),真要在正文上
 *  也能拖,得靠 `simultaneousWithExternalGesture` 或者拿 `onScroll` 门到「已经滚到顶」才放行
 *  —— 两条都要手工协调两套手势系统,协调错了要么正文完全滚不动,要么一从顶部往上滚就被
 *  当成关闭。这里选把手/标题单独接管手势,彻底避开这层歧义,代价是正文里往下拖不会关(
 *  这也是很多原生 sheet 的实际手感——只有把手区能拖)。
 *
 * ★★RNGH 在 RN 的 `Modal` 里默认不生效——`Modal` 在原生端另起一棵视图树(iOS 上是新窗口),
 *  最外层挂的那个 `GestureHandlerRootView`(`app/_layout.tsx`)够不到里面,手势会**静默**
 *  不响应。所以 `Modal` 内容自己再包一层 `GestureHandlerRootView`。这条在 react-native-web
 *  的无头 Chrome 测试里验不出来(web 版 `Modal` 就是个普通 DOM 层,不存在这棵树的问题)——
 *  需要真机确认。
 *
 * ★★2026-08-29 review 两修:①归零时机从「关闭时」改成「打开时」,见下面 `useEffect` 处的
 *  注释——原来那版会在拖着关掉的瞬间先跳回全展开状态一帧,再滑出去。②手势条(把手+标题)
 *  补了 `minHeight: 44`——不带 `sub` 时原来只有 ~42px,是个静默的、只在没传 `sub` 的下一个
 *  调用方身上才会现形的死区。
 */
export function Sheet({
  open,
  onClose,
  title,
  sub,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  sub?: string
  children: React.ReactNode
}) {
  const c = useC()
  const insets = useSafeAreaInsets()
  const y = useSharedValue(0)
  const panelHeight = useSharedValue(0)

  // ★`open` 变 true(重新打开)时把 y 归零 —— 注意不是变 false 时归零。
  //  拖着关的那一刻 `y.value` 还停在拖到的位置,`onEnd` 直接 `runOnJS(onClose)()`,
  //  这一步本身不带动画;如果在这里(`!open`)归零,`y.value` 会在 `Modal` 自己的原生
  //  滑出动画开始**之前**瞬间跳回 0 —— 面板整个先跳回全展开的位置一帧,再沿另一条
  //  动画通道滑出去,观感是「往回一跳再消失」,跟这次要做的「跟着松手那一下的方向甩出去」
  //  正好相反。归零改到下一次**打开**时做,关闭这一刻就保持 `y.value` 原样,让 `Modal`
  //  的原生滑出动画接着已经拖出去的位置走,不再跳回。
  useEffect(() => {
    if (open) y.value = 0
  }, [open, y])

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      y.value = Math.max(0, e.translationY)
    })
    .onEnd((e) => {
      const pastQuarter = panelHeight.value > 0 && y.value > panelHeight.value / 4
      const flicked = e.velocityY > 800
      if (pastQuarter || flicked) {
        runOnJS(onClose)()
      } else {
        y.value = withSpring(0)
      }
    })

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }],
  }))

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* 遮罩本身就是「点外面关掉」的热区 —— 手机上没有 Esc。 */}
        <Pressable style={[st.scrim, { backgroundColor: c.scrim }]} onPress={onClose} />
        <Animated.View
          onLayout={(e) => {
            panelHeight.value = e.nativeEvent.layout.height
          }}
          style={[
            st.sheet,
            { backgroundColor: c.surface, borderTopColor: c.border2, paddingBottom: Math.max(14, insets.bottom) },
            panelStyle,
          ]}
        >
          <GestureDetector gesture={pan}>
            <View style={st.header}>
              <View style={[st.grab, { backgroundColor: c.border2 }]} />
              <T style={{ marginHorizontal: 16, marginTop: 6, fontSize: 16.5, fontWeight: '600', color: c.fg }}>
                {title}
              </T>
              {sub ? (
                <T style={{ marginHorizontal: 16, marginTop: 2, fontSize: 12.5, lineHeight: 19, color: c.muted }}>
                  {sub}
                </T>
              ) : null}
            </View>
          </GestureDetector>
          <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>{children}</ScrollView>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  )
}

const st = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '86%',
    borderTopLeftRadius: RADIUS.sheet,
    borderTopRightRadius: RADIUS.sheet,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grab: { width: 38, height: 4, borderRadius: 999, alignSelf: 'center', marginTop: 9, marginBottom: 3 },
  // ★44pt 是这个手势条的硬下限,不是「今天所有调用方都传了 sub 所以够高」这种巧合。
  //  不带 `sub` 时把手(16px)+ 标题(~26px)只有 ~42px —— 差 2px 就是一个死区,而且是
  //  静默的:不会报错,只会在真机上摸起来「差一点点点不中」。禁止用 `hitSlop` 补 ——
  //  这个 `View` 的祖先(`Animated.View` 面板)紧贴着它,Fabric 的 `overflowInset` 会把
  //  `hitSlop` 扩出去的那圈直接吃掉,等于没加。
  header: { minHeight: 44 },
})
