import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Appearance, Platform, useColorScheme } from 'react-native'
import { DARK, LIGHT, type Palette, type ThemeName } from './tokens'
import {
  DEFAULT_PREFS,
  TEXT_SCALE,
  loadPrefs,
  nativeColorScheme,
  savePrefs,
  type TextSize,
  type ThemePref,
} from '../data/prefs'

/** 等宽栈按平台给 —— iOS 有 SF Mono/Menlo,Android 只有 'monospace',web 用完整 CSS 栈。 */
export const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
}) as string

type Ctx = {
  c: Palette
  name: ThemeName
  /** 用户选的档(不是最终生效的那个)。设置屏上要打勾的是它。 */
  pref: ThemePref
  setPref: (p: ThemePref) => void
  text: TextSize
  setText: (t: TextSize) => void
  /** 正文字号倍率。`T` 拿它乘每一处 fontSize / lineHeight。 */
  scale: number
}

/**
 * ★默认值必须是**完整**的一份,不能只填 `c` 和 `name`。
 *  这个 context 的默认值是有人真的会读到的(Provider 之外、或者挂载顺序上抢在前面的组件),
 *  而 `T` 现在每一段文字都要 `useTheme().scale` —— 少一个字段就是运行时
 *  「读 undefined 的属性」当场白屏,而 typecheck 一个字都不会说,因为默认值被标成了完整的 `Ctx`。
 */
const ThemeCtx = createContext<Ctx>({
  c: DARK,
  name: 'dark',
  pref: 'system',
  setPref: () => {},
  text: 'md',
  setText: () => {},
  scale: 1,
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme()
  const [pref, setPrefState] = useState<ThemePref>(DEFAULT_PREFS.theme)
  const [text, setTextState] = useState<TextSize>(DEFAULT_PREFS.text)

  // 存在手机上的偏好是异步读的。读回来之前先按默认渲染(跟随系统 + 标准字号),
  // 不卡一屏空白 —— 那一下顶多是主题闪一次,而白屏是「app 打不开」。
  useEffect(() => {
    let alive = true
    void loadPrefs().then((p) => {
      if (!alive) return
      setPrefState(p.theme)
      setTextState(p.text)
    })
    return () => { alive = false }
  }, [])

  /**
   * ★★把用户选的档同步给**原生层**。只换 JS 调色板是不够的 —— 理由完整版在
   *  `prefs.ts` 的 `nativeColorScheme`(一句话:原生 window 不改的话仍停在 night 模式,
   *  ROM 会一直把这个 app 当深色 app 处理,安卓上「选了浅色还是深的」就是这么来的)。
   * ★放在 effect 里跟着 `pref` 走,而不是塞进 `setPref` —— 冷启动从磁盘读回来的那一次
   *  也必须同步过去,而那一次不经过 `setPref`。
   */
  // ★★`?.`不是多余的防御:**react-native-web 的 `Appearance` 没有 `setColorScheme`**
  //  (它只读系统的 prefers-color-scheme,改不了)。裸调是一个 TypeError,而它就在
  //  `ThemeProvider` 的 effect 里 —— 于是**整个网页版当场红屏**,连设置屏都打不开,
  //  e2e 那一套(全部跑在 react-native-web 上)也一条都跑不了。
  //  原生两端有这个方法,所以它要修的那个现象(安卓 ROM 把 app 当深色 app)一点没受影响。
  useEffect(() => { Appearance.setColorScheme?.(nativeColorScheme(pref)) }, [pref])

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p)          // 先落到界面上,别等写盘 —— 点一下要立刻看见变化
    void savePrefs({ theme: p, text })
  }, [text])

  const setText = useCallback((t: TextSize) => {
    setTextState(t)
    void savePrefs({ theme: pref, text: t })
  }, [pref])

  const value = useMemo<Ctx>(() => {
    // ★覆盖优先于系统。`pref === 'system'` 才看 useColorScheme。
    // 深色是最后的默认 —— 原型的主视图是深色,系统没报偏好时不该突然给一屏白的。
    const name: ThemeName = pref === 'system' ? (scheme === 'light' ? 'light' : 'dark') : pref
    return {
      c: name === 'light' ? LIGHT : DARK,
      name,
      pref,
      setPref,
      text,
      setText,
      scale: TEXT_SCALE[text],
    }
  }, [scheme, pref, text, setPref, setText])

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export const useTheme = () => useContext(ThemeCtx)
export const useC = () => useContext(ThemeCtx).c
