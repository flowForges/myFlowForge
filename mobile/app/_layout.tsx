import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeProvider, useTheme } from '../src/theme/theme'
import { ConnProvider } from '../src/net/conn'
import { StoreProvider } from '../src/data/store'
import { installPRNG } from '../src/net/prng'

// ★★在**任何东西**加载之前接上随机数源。tweetnacl 拿不到 `crypto.getRandomValues` 时
//  它的 randombytes 是一个 `throw new Error('no PRNG')` —— 而 RN 上确实没有这个全局。
//  放在模块顶层(不是某个 effect 里)是有意的:握手可能发生在任何一屏,
//  而"哪一屏先渲染"是会变的。理由完整版见 `src/net/prng.ts`。
installPRNG()

function Nav() {
  const { c, name } = useTheme()
  return (
    <>
      <StatusBar style={name === 'dark' ? 'light' : 'dark'} />
      {/* 层级只用「推入 / 退出」,没有需要猜的手势;每一层左上角必有返回。
          顶栏是我们自己画的,所以这里把系统 header 全关掉。
          ★★`(tabs)` 是根栈的**第一屏**,其余全部推在它上面 —— 所以次级屏天然盖住
           底部那条 tab bar,不需要一屏一屏去写 `tabBarStyle: { display: 'none' }`。
          ★`initialRouteName` 钉死冷启动落点:杀进程重开必须回到会话列表那一格。 */}
      <Stack
        initialRouteName="(tabs)"
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }}
      />
    </>
  )
}

export default function RootLayout() {
  return (
    // ★★`GestureHandlerRootView` 必须在**最外层**(SafeAreaProvider 外面),
    //  而且必须有 `flex: 1` —— 少了它整个 app 是一片空白,少了外层位置左滑手势会**静默**不响应。
    //  `react-native-gesture-handler` 一直在 package.json 里、原生也链好了,但在这之前
    //  全项目一行都没用过,所以这个 Provider 从来没挂过。Task 8 的左滑靠它。
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ConnProvider>
            <StoreProvider>
              <Nav />
            </StoreProvider>
          </ConnProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
