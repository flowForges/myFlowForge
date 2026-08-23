import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeProvider, useTheme } from '../src/theme/theme'
import { ConnProvider } from '../src/net/conn'
import { StoreProvider } from '../src/data/store'

function Nav() {
  const { c, name } = useTheme()
  return (
    <>
      <StatusBar style={name === 'dark' ? 'light' : 'dark'} />
      {/* 层级只用「推入 / 退出」,没有需要猜的手势;每一层左上角必有返回(设计层 D 的三条原则之二)。
          顶栏是我们自己画的,所以这里把系统 header 全关掉。 */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }} />
    </>
  )
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ConnProvider>
          <StoreProvider>
            <Nav />
          </StoreProvider>
        </ConnProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
