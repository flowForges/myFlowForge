import React, { useEffect, useMemo, useState } from 'react'
import { Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
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
 *
 * ★★2026-08-29 真机第六轮:**面板不躲键盘**。这个面板是 `position:absolute; bottom:0`,
 *  而键盘是盖在最上面的一层原生视图 —— 于是任何一张带输入框的单子(重命名工作区、重命名会话)
 *  一打开、`autoFocus` 把键盘唤起来,整张面板连同标题、原名、输入框、保存键**全部**在键盘底下,
 *  屏幕上只剩一个键盘和后面那张列表。用户原话:「看不到到底在重命名什么,当前什么样」。
 *  ★为什么不是 `KeyboardAvoidingView`:那个东西靠给**自己**加 padding/height 把子节点顶上去,
 *   对一个 `position:absolute; bottom:0` 的子节点无效(绝对定位不参与父节点的内容盒排布)。
 *   直接抬 `bottom` 才是对症的。
 *  ★`maxHeight` 必须跟着一起减,而且不能再用百分比:百分比量的是 `Modal` 那棵全屏视图树,
 *   键盘顶上来之后 `bottom + 86%` 会超过屏幕高度,超出去的是**顶部** —— 把手和标题被推出屏幕外,
 *   于是「拖着关」也一起没了。所以改成按窗口高度算的绝对值。
 *  ★iOS 用 `keyboardWillShow`(和键盘动画同帧起步,面板跟着一起上来);Android 没有 will 系列,
 *   退 `keyboardDidShow`。
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
  const { height: winH } = useWindowDimensions()
  const y = useSharedValue(0)
  const panelHeight = useSharedValue(0)
  // 键盘现在有多高。0 = 没有键盘。★只在这张单子**开着**的时候订阅:RN 的 `Modal` 在
  // `visible={false}` 时返回 null,所以同屏那一堆没打开的单子根本不在树上,不会有 N 份监听。
  //
  // 两份:`kb`(JS state)只给 `maxHeight` / `paddingBottom` 这类要走布局的属性用;
  // `kbLift`(shared value)负责真正把面板抬起来。★分开是因为**抬起来必须跟着键盘的动画走**:
  // iOS 的 `keyboardWillShow` 是在键盘动画**开始**的那一刻发的,直接改布局的话面板瞬移到位、
  // 键盘还在底下慢慢升,中间会露出一条越缩越小的缝。用 `withTiming` 借键盘自己报的 `duration`
  // 走同一条曲线,两者就贴在一起。
  const [kb, setKb] = useState(0)
  const kbLift = useSharedValue(0)
  useEffect(() => {
    if (!open) {
      setKb(0)
      kbLift.value = 0
      return
    }
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    // ★`duration` 只有 iOS 的 will 系列会给;Android 的 did 系列是键盘**已经**在那儿了,
    //  此时再走一段动画只会慢半拍,所以退成 0(瞬间到位)。
    const on = Keyboard.addListener(showEv, (e) => {
      const h = e.endCoordinates?.height ?? 0
      setKb(h)
      kbLift.value = withTiming(h, { duration: e.duration ?? 0 })
    })
    const off = Keyboard.addListener(hideEv, (e) => {
      setKb(0)
      kbLift.value = withTiming(0, { duration: e.duration ?? 0 })
    })
    return () => {
      on.remove()
      off.remove()
    }
  }, [open, kbLift])

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

  // ★`.enabled(open)`:`Modal` 的滑出动画还在跑的那一小段里,面板仍在树上、手势仍然活着 ——
  //  那期间再拖一下就是**第二次** `onClose`。今天的调用方全是幂等的 `setState`,所以看不出问题,
  //  但那是运气,不是设计。关掉的那一刻手势就该失效。
  // ★`useMemo`:`Gesture.Pan()` 每次渲染都重建一个新手势对象,而这个组件跟着键盘高度重渲染
  //  (`kb` 是 state)—— 拖到一半时重建手势是 RNGH 里「拖着拖着突然不跟手」的经典来源。
  const pan = useMemo(
    () => Gesture.Pan()
      .enabled(open)
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
      }),
    [open, onClose, y, panelHeight],
  )

  // `y` 是往下拖的位移(正数),`kbLift` 是被键盘顶起的高度 —— 一个往下一个往上,合成一条。
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value - kbLift.value }],
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
            {
              backgroundColor: c.surface,
              borderTopColor: c.border2,
              // ★抬起来那一下走的是上面的 `kbLift`(transform),不是 `bottom` —— transform 不触发
              //  布局,和键盘的动画能贴在一条曲线上。这里只留跟着走的两个布局属性。
              // 键盘顶着的时候底部安全区已经被键盘占了,再留一份就是凭空多出一条空白。
              paddingBottom: kb > 0 ? 14 : Math.max(14, insets.bottom),
              maxHeight: Math.max(180, winH * 0.86 - kb),
            },
            panelStyle,
          ]}
        >
          <GestureDetector gesture={pan}>
            <View style={st.header}>
              <View style={[st.grab, { backgroundColor: c.border2 }]} />
              <T style={{ marginHorizontal: 16, marginTop: 6, fontSize: 16.5, fontWeight: '600', color: c.fg }}>
                {title}
              </T>
              {/* ★3 行封顶:副标题现在会带上「原名 …」(见重命名那两张单子),而工作区名可以任意长
                  —— 不封的话手势条会被撑到半屏高,把手和正文一起被挤下去。 */}
              {sub ? (
                <T numberOfLines={3} style={{ marginHorizontal: 16, marginTop: 2, fontSize: 12.5, lineHeight: 19, color: c.muted }}>
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
    // ★`maxHeight` 在行内按键盘高度算(见上面),这里不写死 —— 写死会和行内那份形成两个
    //  事实来源,而 RN 的样式数组是后者赢,读代码的人会以为这里生效。
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
