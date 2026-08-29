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

  // ★`open` 变 false 时把 y 归零,否则下次打开是从上次拖到的位置开始的。
  useEffect(() => {
    if (!open) y.value = 0
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
            <View>
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
})
