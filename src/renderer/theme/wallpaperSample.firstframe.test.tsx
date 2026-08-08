import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useWallpaperPalette } from './wallpaperSample'
import type { Appearance } from '@shared/types'

// 开屏配色闪烁的回归守卫。settings 是异步从 IPC 回来的,所以 useWallpaperPalette 第一次挂载时拿到的是
// undefined;等设置到达时,它必须**在同一帧**就能给出已缓存的壁纸配色,否则 applyTheme 会先用用户的基础
// 强调色渲染一帧(自定义强调色可能是任意颜色 → 开屏闪一下别的颜色再变成壁纸色)。

const base = { theme: 'light', accent: 'custom', accentCustom: '#e60f82', autoWallpaperTheme: true,
  vibrancy: false, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 14,
  chatFontSize: 14, chatLineHeight: 1.7, chatLetterSpacing: 0, chatInlineHtml: false, fontFamily: '',
  textWeight: 450, bgImage: 'forge-bg://img/abc.png', bgScope: 'app', bgOpacity: .35, bgWallpaperId: '',
  homeBgImage: '', homeBgOn: false, homeBgOpacity: .35, bgPositions: {} } as unknown as Appearance

const PAL = { hueBase: 240, hueAccent: 20, dark: false }

// 这个 renderer 测试环境没有 localStorage,自己兜一个最小实现(取色缓存就存在这里)。
let store: Record<string, string> = {}
beforeEach(() => {
  store = {}
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
    },
  })
  vi.restoreAllMocks()
})

describe('useWallpaperPalette 首帧', () => {
  it('★ 设置迟到时,设置到达的那一帧就带上缓存的壁纸配色(不闪基础强调色)', () => {
    // 预热缓存,模拟「这张壁纸以前算过」(壁纸 URL 内容寻址,缓存永远有效)
    store['forge.wpPalette.v4'] = JSON.stringify({ 'forge-bg://img/abc.png': PAL })
    // 必须记录**每一次 render 当时**的返回值:applyTheme 是在 render 提交后的 effect 里跑的,只看
    // result.current(effect 都跑完之后的稳定值)分不出「当帧就有」和「又补渲染了一帧才有」——
    // 而那多出来的一帧正是用户看到的那下闪色。
    const seen: (typeof PAL | null)[] = []
    const { rerender } = renderHook(
      ({ a }) => { const p = useWallpaperPalette(a); seen.push(p as typeof PAL | null); return p },
      { initialProps: { a: undefined as Appearance | undefined } },
    )
    seen.length = 0            // 丢掉设置到达之前的渲染
    rerender({ a: base })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toEqual(PAL)   // 设置到达的第一帧就已经是壁纸配色
  })

  it('缓存未命中时仍返回 null(交给异步取样),不乱编一个配色', () => {
    // 换一张没见过的壁纸 —— 模块级内存 memo 会跨用例留存,复用同一 URL 会命中上一条用例写进去的结果。
    const { result } = renderHook(() => useWallpaperPalette({ ...base, bgImage: 'forge-bg://img/never-seen.png' }))
    expect(result.current).toBeNull()
  })

  it('关掉「跟随壁纸配色」时恒为 null', () => {
    store['forge.wpPalette.v4'] = JSON.stringify({ 'forge-bg://img/abc.png': PAL })
    const { result } = renderHook(() => useWallpaperPalette({ ...base, autoWallpaperTheme: false }))
    expect(result.current).toBeNull()
  })
})
