import { describe, it, expect } from 'vitest'
import {
  PALETTE_PROPS, TUNING, extractPalette, hueGap, paletteSwatches, paletteVars, srgbToOklch,
  wallpaperSourceFor, type WallpaperPalette,
} from './wallpaperPalette'
import type { Appearance } from '@shared/types'

// 把 "#rrggbb" 展开成 n 个像素的 RGBA;拼起来就是一张「合成壁纸」,不需要真 canvas。
function fill(hex: string, n: number, alpha = 255): number[] {
  const v = parseInt(hex.slice(1), 16)
  const px = [(v >> 16) & 255, (v >> 8) & 255, v & 255, alpha]
  return Array.from({ length: n }, () => px).flat()
}
const img = (...parts: number[][]) => new Uint8ClampedArray(parts.flat())

const hueOf = (hex: string) => srgbToOklch(...(fill(hex, 1).slice(0, 3) as [number, number, number])).h

describe('srgbToOklch', () => {
  it('白/黑是无彩色,明度落在两端', () => {
    const w = srgbToOklch(255, 255, 255)
    const k = srgbToOklch(0, 0, 0)
    expect(w.L).toBeCloseTo(1, 2)
    expect(w.C).toBeLessThan(0.002)
    expect(k.L).toBeCloseTo(0, 2)
  })

  it('中性灰的彩度接近 0,饱和色的彩度明显更高', () => {
    expect(srgbToOklch(128, 128, 128).C).toBeLessThan(0.002)
    expect(srgbToOklch(255, 0, 0).C).toBeGreaterThan(0.2)
  })

  it('色相角能区分红/绿/蓝', () => {
    const r = srgbToOklch(255, 0, 0).h
    const g = srgbToOklch(0, 255, 0).h
    const b = srgbToOklch(0, 0, 255).h
    expect(hueGap(r, g)).toBeGreaterThan(60)
    expect(hueGap(g, b)).toBeGreaterThan(60)
    expect(hueGap(r, b)).toBeGreaterThan(60)
  })
})

describe('hueGap', () => {
  it('走色环短边,跨 0° 不会算成 350°', () => {
    expect(hueGap(10, 350)).toBeCloseTo(20, 5)
    expect(hueGap(350, 10)).toBeCloseTo(20, 5)
    expect(hueGap(0, 180)).toBeCloseTo(180, 5)
  })
})

describe('extractPalette · 基调判定', () => {
  it('暗壁纸 → dark', () => {
    expect(extractPalette(img(fill('#101828', 100)))!.base).toBe('dark')
  })

  it('亮壁纸 → light', () => {
    expect(extractPalette(img(fill('#eef2ff', 100)))!.base).toBe('light')
  })

  it('空输入返回 null', () => {
    expect(extractPalette(new Uint8ClampedArray(0))).toBeNull()
  })

  it('全透明像素不参与统计 → 返回 null 而不是把透明当黑色', () => {
    expect(extractPalette(img(fill('#ff0000', 50, 0)))).toBeNull()
  })
})

describe('extractPalette · 取色', () => {
  it('单色壁纸:主调=该色相,点缀色退化成同色相', () => {
    const p = extractPalette(img(fill('#1d4ed8', 200)))!
    expect(hueGap(p.hueBg, hueOf('#1d4ed8'))).toBeLessThan(10)
    expect(p.hueAccent).not.toBeNull()
    expect(p.hueAccent).toBe(p.hueBg)
  })

  it('大面积主调 + 小面积高饱和点缀:分别取到两个色相', () => {
    // 95% 深青绿 + 5% 亮橙 —— 就是「夕阳/霓虹」那种壁纸的最小模型。
    const p = extractPalette(img(fill('#0f6f6a', 950), fill('#ff7a1a', 50)))!
    expect(hueGap(p.hueBg, hueOf('#0f6f6a'))).toBeLessThan(15)
    expect(hueGap(p.hueAccent!, hueOf('#ff7a1a'))).toBeLessThan(15)
    expect(hueGap(p.hueBg, p.hueAccent!)).toBeGreaterThanOrEqual(TUNING.ACCENT_MIN_HUE_GAP)
  })

  it('点缀色面积太小(低于门槛)时不被选中,退化成单色相', () => {
    // 2 / 1002 ≈ 0.2%,低于 ACCENT_MIN_SHARE(1.5%)→ 当噪点丢掉。
    const p = extractPalette(img(fill('#0f6f6a', 1000), fill('#ff7a1a', 2)))!
    expect(p.hueAccent).toBe(p.hueBg)
  })

  it('灰度壁纸:不取色相,强调色交还给用户(hueAccent=null)', () => {
    const p = extractPalette(img(fill('#1a1a1a', 400), fill('#8a8a8a', 300), fill('#d4d4d4', 300)))!
    expect(p.hueAccent).toBeNull()
    expect(p.chromaBg).toBe(0)
    expect(p.base).toBe('dark')
  })

  it('tint 彩度永远夹在调参区间内(哪怕壁纸是纯饱和色)', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#1d4ed8', '#0f6f6a']) {
      const p = extractPalette(img(fill(hex, 200)))!
      expect(p.chromaBg).toBeGreaterThanOrEqual(TUNING.TINT_MIN)
      expect(p.chromaBg).toBeLessThanOrEqual(TUNING.TINT_MAX)
    }
  })
})

describe('paletteVars · 对比度护栏', () => {
  const dark: WallpaperPalette = { base: 'dark', hueBg: 264, chromaBg: 0.02, hueAccent: 40 }
  const light: WallpaperPalette = { base: 'light', hueBg: 90, chromaBg: 0.02, hueAccent: 200 }
  const L = (v: string) => Number(/oklch\(([\d.]+)%/.exec(v)![1])

  it('深色基调:明度阶梯照抄内置深色主题(底 20% / 侧栏 17% / 正文 95%)', () => {
    const v = paletteVars(dark)
    expect(L(v['--bg'])).toBe(20)
    expect(L(v['--sidebar'])).toBe(17)
    expect(L(v['--fg'])).toBe(95)
    // 次级文字必须显著亮于底色 —— 皮肤系统那轮 --muted/--faint 失明的坑就在这。
    expect(L(v['--muted'])).toBeGreaterThan(L(v['--bg']) + 30)
    expect(L(v['--faint'])).toBeGreaterThan(L(v['--bg']) + 20)
  })

  it('浅色基调:正文远暗于底色', () => {
    const v = paletteVars(light)
    expect(L(v['--bg'])).toBe(98)
    expect(L(v['--fg'])).toBe(24)
    expect(L(v['--muted'])).toBeLessThan(L(v['--bg']) - 30)
  })

  it('壁纸只能影响色相:所有中性色都用 hueBg,明度与彩度与壁纸无关', () => {
    const a = paletteVars({ base: 'dark', hueBg: 10, chromaBg: 0.02, hueAccent: 200 })
    const b = paletteVars({ base: 'dark', hueBg: 300, chromaBg: 0.02, hueAccent: 200 })
    expect(L(a['--bg'])).toBe(L(b['--bg']))
    expect(a['--bg']).toContain(' 10')
    expect(b['--bg']).toContain(' 300')
  })

  it('accent 落在与内置预设强调色相同的波段(深色 L72/C.15、浅色 L56/C.16)', () => {
    expect(paletteVars(dark)['--accent']).toBe('oklch(72% 0.15 40)')
    expect(paletteVars(light)['--accent']).toBe('oklch(56% 0.16 200)')
  })

  it('深色 accent 配深字、浅色 accent 配白字', () => {
    expect(paletteVars(dark)['--on-accent']).toContain('15%')
    expect(paletteVars(light)['--on-accent']).toBe('oklch(99% 0 0)')
  })

  it('灰度壁纸只产出中性色,不产出 accent 四件套', () => {
    const v = paletteVars({ base: 'dark', hueBg: 0, chromaBg: 0, hueAccent: null })
    expect(v['--bg']).toBeDefined()
    expect(v['--accent']).toBeUndefined()
    expect(v['--accent-dim']).toBeUndefined()
    expect(v['--run']).toBeUndefined()
    expect(v['--on-accent']).toBeUndefined()
  })

  it('PALETTE_PROPS 覆盖 paletteVars 可能产出的每一个属性(否则关掉开关会有残留)', () => {
    const emitted = new Set([...Object.keys(paletteVars(dark)), ...Object.keys(paletteVars(light))])
    for (const prop of emitted) expect(PALETTE_PROPS).toContain(prop)
  })

  it('色点预览给出四个可用颜色', () => {
    expect(paletteSwatches(dark)).toHaveLength(4)
    expect(paletteSwatches(dark).every(c => c.startsWith('oklch('))).toBe(true)
    // 灰度壁纸没有 accent,预览用 surface-2 兜底,不能是 undefined
    expect(paletteSwatches({ base: 'dark', hueBg: 0, chromaBg: 0, hueAccent: null }).every(Boolean)).toBe(true)
  })
})

describe('wallpaperSourceFor', () => {
  const a = (over: Partial<Appearance>) => ({
    bgImage: '', bgScope: 'off', homeBgImage: '', homeBgOn: false, ...over,
  } as Appearance)

  it('优先用应用/会话区背景图', () => {
    expect(wallpaperSourceFor(a({ bgImage: 'forge-bg://img/a.png', bgScope: 'app', homeBgImage: 'forge-bg://img/b.png', homeBgOn: true })))
      .toBe('forge-bg://img/a.png')
  })

  it('背景范围关掉时回落到首页背景图', () => {
    expect(wallpaperSourceFor(a({ bgImage: 'forge-bg://img/a.png', bgScope: 'off', homeBgImage: 'forge-bg://img/b.png', homeBgOn: true })))
      .toBe('forge-bg://img/b.png')
  })

  it('都没有(或首页开关关着)时返回空', () => {
    expect(wallpaperSourceFor(a({}))).toBe('')
    expect(wallpaperSourceFor(a({ homeBgImage: 'forge-bg://img/b.png', homeBgOn: false }))).toBe('')
    expect(wallpaperSourceFor(undefined)).toBe('')
  })
})
