import React, { createContext, useContext, useMemo } from 'react'
import { Platform, useColorScheme } from 'react-native'
import { DARK, LIGHT, type Palette, type ThemeName } from './tokens'

/** 等宽栈按平台给 —— iOS 有 SF Mono/Menlo,Android 只有 'monospace',web 用完整 CSS 栈。 */
export const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
}) as string

type Ctx = { c: Palette; name: ThemeName }
const ThemeCtx = createContext<Ctx>({ c: DARK, name: 'dark' })

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme()
  // 跟随系统。深色是默认 —— 原型的主视图是深色,系统没报偏好时不该突然给一屏白的。
  const value = useMemo<Ctx>(
    () => (scheme === 'light' ? { c: LIGHT, name: 'light' } : { c: DARK, name: 'dark' }),
    [scheme],
  )
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export const useTheme = () => useContext(ThemeCtx)
export const useC = () => useContext(ThemeCtx).c
