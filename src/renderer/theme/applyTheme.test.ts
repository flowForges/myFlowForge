import { describe, it, expect, afterEach, vi } from 'vitest'
import { applyTheme, onAccentFor, bgSaturation, bgScrim, BRIGHT_WALLPAPER_CAP } from './applyTheme'
import type { Appearance } from '@shared/types'

const base: Appearance = { theme: 'dark', accent: 'blue', autoWallpaperTheme: false, vibrancy: true, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 14, chatFontSize: 14, chatLineHeight: 1.7, chatLetterSpacing: 0, chatInlineHtml: false, fontFamily: '', textWeight: 450, bgImage: '', bgScope: 'off', bgOpacity: 0.35, bgWallpaperId: '', homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35, bgPositions: {} }
afterEach(() => { document.documentElement.removeAttribute('data-theme'); document.documentElement.removeAttribute('data-vibrancy'); document.documentElement.removeAttribute('data-glass'); document.documentElement.removeAttribute('data-density'); document.documentElement.removeAttribute('data-skin') })

describe('applyTheme', () => {
  it('sets root data attributes from appearance', () => {
    // 应用字号(fontSize)走主进程 setZoomFactor,不在 applyTheme 里设 DOM,这里只验其余属性。
    applyTheme({ ...base, theme: 'light', vibrancy: false, density: 'compact', fontSize: 15.5 })
    const r = document.documentElement
    expect(r.getAttribute('data-theme')).toBe('light')
    expect(r.getAttribute('data-vibrancy')).toBe('off')
    expect(r.getAttribute('data-density')).toBe('compact')
  })
  it('drives --chat-font-scale from chatFontSize px (÷14 base)', () => {
    applyTheme({ ...base, chatFontSize: 17.5 })
    expect(document.documentElement.style.getPropertyValue('--chat-font-scale')).toBe('1.25')
  })
  it('sets data-glass from appearance.glass', () => {
    applyTheme({ ...base, glass: true })
    expect(document.documentElement.getAttribute('data-glass')).toBe('on')
    applyTheme({ ...base, glass: false })
    expect(document.documentElement.getAttribute('data-glass')).toBe('off')
  })
  it('turns glass on and scales blur strength from blurAmount', () => {
    applyTheme({ ...base, glass: false, blurAmount: 0.4 })
    const r = document.documentElement
    expect(r.getAttribute('data-glass')).toBe('on')
    expect(r.style.getPropertyValue('--glass-blur-strength')).toBe('0.4')
  })
  it('blurAmount 0 leaves glass off and blur strength at 1', () => {
    applyTheme({ ...base, glass: false, blurAmount: 0 })
    const r = document.documentElement
    expect(r.getAttribute('data-glass')).toBe('off')
    expect(r.style.getPropertyValue('--glass-blur-strength')).toBe('1')
  })
  it('sets --app-bg-pos from bgPositions keyed by image URL (default when absent)', () => {
    // Remembered position for the active image wins…
    applyTheme({ ...base, bgImage: 'forge-bg://w1.jpg', bgPositions: { 'forge-bg://w1.jpg': 12 } })
    expect(document.documentElement.style.getPropertyValue('--app-bg-pos')).toBe('12%')
    // …and an image with no stored position falls back to the slightly-top default (35%).
    applyTheme({ ...base, bgImage: 'forge-bg://other.jpg', bgPositions: { 'forge-bg://w1.jpg': 12 } })
    expect(document.documentElement.style.getPropertyValue('--app-bg-pos')).toBe('35%')
  })
  it('sets --home-bg-pos from bgPositions keyed by the home image URL', () => {
    applyTheme({ ...base, homeBgImage: 'forge-bg://home.jpg', bgPositions: { 'forge-bg://home.jpg': 80 } })
    expect(document.documentElement.style.getPropertyValue('--home-bg-pos')).toBe('80%')
  })
  it('custom accent writes inline --accent + derived vars, and clears them for a preset', () => {
    const r = document.documentElement
    applyTheme({ ...base, accent: 'custom', accentCustom: '#ff8800' })
    expect(r.getAttribute('data-accent')).toBe('custom')
    expect(r.style.getPropertyValue('--accent')).toBe('#ff8800')
    expect(r.style.getPropertyValue('--accent-dim')).toBe('color-mix(in oklab, #ff8800 16%, transparent)')
    expect(r.style.getPropertyValue('--run')).toBe('#ff8800')
    expect(r.style.getPropertyValue('--on-accent')).toBe('oklch(20% 0 0)') // bright orange → dark text
    // Switching back to a preset must remove the inline overrides so the [data-accent] CSS takes over again.
    applyTheme({ ...base, accent: 'blue' })
    expect(r.style.getPropertyValue('--accent')).toBe('')
    expect(r.style.getPropertyValue('--on-accent')).toBe('')
  })
  it('activeSkin 打/清 data-skin;未知 id 不设属性', () => {
    const r = document.documentElement
    applyTheme({ ...base, activeSkin: 'forge' })
    expect(r.getAttribute('data-skin')).toBe('forge')
    // 切到另一套皮肤
    applyTheme({ ...base, activeSkin: 'aurora' })
    expect(r.getAttribute('data-skin')).toBe('aurora')
    // 清空 → 属性消失
    applyTheme({ ...base, activeSkin: null })
    expect(r.hasAttribute('data-skin')).toBe(false)
    // 未知 id → 当作无皮肤,不设属性(防御脏配置)
    applyTheme({ ...base, activeSkin: 'no-such-skin' })
    expect(r.hasAttribute('data-skin')).toBe(false)
  })
  it('皮肤生效时 data-theme 跟随皮肤明暗基调,盖过用户主题', () => {
    const r = document.documentElement
    // 用户主题为 dark,但套浅色皮肤 ink → data-theme 应变 light(否则 dark 硬编码白字会失明)
    applyTheme({ ...base, theme: 'dark', activeSkin: 'ink' })
    expect(r.getAttribute('data-theme')).toBe('light')
    // 深色皮肤 forge → data-theme dark
    applyTheme({ ...base, theme: 'light', activeSkin: 'forge' })
    expect(r.getAttribute('data-theme')).toBe('dark')
    // 清皮肤 → 回到用户自己的主题
    applyTheme({ ...base, theme: 'light', activeSkin: null })
    expect(r.getAttribute('data-theme')).toBe('light')
  })
  it('onAccentFor picks readable text: dark on light colors, white on dark/invalid', () => {
    expect(onAccentFor('#ffffff')).toBe('oklch(20% 0 0)')
    expect(onAccentFor('#000000')).toBe('oklch(99% 0 0)')
    expect(onAccentFor('#1e3a8a')).toBe('oklch(99% 0 0)') // deep blue → white text
    expect(onAccentFor('not-a-hex')).toBe('oklch(99% 0 0)')
  })
  // ---- 跟随壁纸配色(自动皮肤):接管明暗 + 中性色 + 强调色,关掉不留残留 ----
  const wpBase = { ...base, autoWallpaperTheme: true, bgImage: 'forge-bg://img/a.png', bgScope: 'app' as const }
  const pal = { base: 'light' as const, hueBg: 90, chromaBg: 0.02, hueAccent: 300 }

  it('壁纸配色接管明暗基调与整套中性色', () => {
    applyTheme(wpBase, pal)
    const r = document.documentElement
    expect(r.getAttribute('data-theme')).toBe('light')          // 用户是 dark,壁纸判浅 → 壁纸说了算
    expect(r.style.getPropertyValue('--bg')).toBe('oklch(98% 0.02 90)')
    expect(r.style.getPropertyValue('--accent')).toBe('oklch(56% 0.16 300)')
  })

  it('壁纸配色盖过手选皮肤(否则皮肤的 motif 与配色打架)', () => {
    applyTheme({ ...wpBase, activeSkin: 'forge' }, pal)
    const r = document.documentElement
    expect(r.hasAttribute('data-skin')).toBe(false)
    expect(r.getAttribute('data-theme')).toBe('light')
  })

  it('开关关掉 → 内联配色全部清干净,回到用户原本的主题', () => {
    applyTheme(wpBase, pal)
    applyTheme({ ...wpBase, autoWallpaperTheme: false }, pal)
    const r = document.documentElement
    expect(r.getAttribute('data-theme')).toBe('dark')
    expect(r.style.getPropertyValue('--bg')).toBe('')
    expect(r.style.getPropertyValue('--accent')).toBe('')
    expect(r.style.getPropertyValue('--glass-window')).toBe('')
  })

  it('还没取到调色板时静默走原路径(不闪、不报错)', () => {
    applyTheme(wpBase, null)
    const r = document.documentElement
    expect(r.getAttribute('data-theme')).toBe('dark')
    expect(r.style.getPropertyValue('--bg')).toBe('')
  })

  it('灰度壁纸:只接管中性色,自定义强调色仍然生效', () => {
    applyTheme({ ...wpBase, accent: 'custom', accentCustom: '#ff0088' }, { base: 'dark', hueBg: 0, chromaBg: 0, hueAccent: null })
    const r = document.documentElement
    expect(r.style.getPropertyValue('--bg')).toBe('oklch(20% 0 0)')
    expect(r.style.getPropertyValue('--accent')).toBe('#ff0088')
  })

  // ---- 强调色可以不跟随壁纸(强调色行里的第一颗「跟随壁纸」被取消选中时)----
  it('wallpaperAccentAuto=false:底色仍跟壁纸,强调色交还给用户的自定义色', () => {
    applyTheme({ ...wpBase, wallpaperAccentAuto: false, accent: 'custom', accentCustom: '#ff0088' }, pal)
    const r = document.documentElement
    // 明暗与中性色照旧由壁纸接管
    expect(r.getAttribute('data-theme')).toBe('light')
    expect(r.style.getPropertyValue('--bg')).toBe('oklch(98% 0.02 90)')
    // 强调色四件套不再由壁纸产出,而是用户那一个
    expect(r.style.getPropertyValue('--accent')).toBe('#ff0088')
    expect(r.style.getPropertyValue('--run')).toBe('#ff0088')
  })

  it('wallpaperAccentAuto=false + 预设强调色:accent 完全不内联,交还给 [data-accent] 选择器', () => {
    applyTheme({ ...wpBase, wallpaperAccentAuto: false, accent: 'rose' }, pal)
    const r = document.documentElement
    expect(r.getAttribute('data-accent')).toBe('rose')
    expect(r.style.getPropertyValue('--bg')).toBe('oklch(98% 0.02 90)')   // 底色仍跟壁纸
    expect(r.style.getPropertyValue('--accent')).toBe('')                 // 没有内联 → tokens.css 的 [data-accent=rose] 生效
    expect(r.style.getPropertyValue('--accent-dim')).toBe('')
    expect(r.style.getPropertyValue('--on-accent')).toBe('')
  })

  it('缺省(老配置没有这个字段)= 跟随壁纸,行为与改动前一致', () => {
    applyTheme({ ...wpBase, accent: 'rose' }, pal)   // 不带 wallpaperAccentAuto
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('oklch(56% 0.16 300)')
  })

  it('从「不跟随」切回「跟随」不留残留', () => {
    applyTheme({ ...wpBase, wallpaperAccentAuto: false, accent: 'custom', accentCustom: '#ff0088' }, pal)
    applyTheme({ ...wpBase, wallpaperAccentAuto: true, accent: 'custom', accentCustom: '#ff0088' }, pal)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('oklch(56% 0.16 300)')
  })

  it('有点缀色时,壁纸强调色压过自定义强调色', () => {
    applyTheme({ ...wpBase, accent: 'custom', accentCustom: '#ff0088' }, pal)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('oklch(56% 0.16 300)')
  })

  // 浅色主题下壁纸「发奶白」的补偿系数。只有 [data-theme=light] 的 CSS 规则消费它,所以这里只验数值本身。
  describe('bgSaturation(壁纸可见度 → 浅色饱和补偿)', () => {
    it('可见度 100% 时不补偿', () => {
      expect(bgSaturation(1)).toBe(1)
    })
    it('可见度越低补得越多,且单调递减', () => {
      expect(bgSaturation(0.3)).toBeGreaterThan(bgSaturation(0.6))
      expect(bgSaturation(0.6)).toBeGreaterThan(bgSaturation(0.9))
    })
    it('补偿有上限,不会把壁纸调成霓虹', () => {
      expect(bgSaturation(0.05)).toBeLessThanOrEqual(1.9)
      expect(bgSaturation(0)).toBeLessThanOrEqual(1.9)
    })
    it('非法输入不产出 NaN', () => {
      expect(bgSaturation(Number.NaN)).toBeGreaterThan(1)
      expect(Number.isFinite(bgSaturation(Number.NaN))).toBe(true)
    })
    it('applyTheme 把它写进 --app-bg-sat', () => {
      applyTheme({ ...base, bgImage: 'forge-bg://x.jpg', bgScope: 'app', bgOpacity: 0.3 })
      expect(document.documentElement.style.getPropertyValue('--app-bg-sat')).toBe(String(bgSaturation(0.3)))
    })
  })

  // 皮肤生效时,皮肤自带的 accent 说了算 —— 预设强调色本来就被 skins.css 接管,自定义色走内联会压过皮肤,
  // 导致「画廊色卡是金色、套上去却是自定义色」。两者行为拉齐。
  describe('皮肤接管强调色', () => {
    it('套皮肤时不写自定义强调色的内联值', () => {
      applyTheme({ ...base, accent: 'custom', accentCustom: '#e60f82', activeSkin: 'lapis' })
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
      expect(document.documentElement.getAttribute('data-skin')).toBe('lapis')
    })
    it('取消皮肤后自定义强调色自动回来', () => {
      applyTheme({ ...base, accent: 'custom', accentCustom: '#e60f82', activeSkin: 'lapis' })
      applyTheme({ ...base, accent: 'custom', accentCustom: '#e60f82', activeSkin: null })
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#e60f82')
    })
    it('没有皮肤时自定义强调色照旧生效', () => {
      applyTheme({ ...base, accent: 'custom', accentCustom: '#123456' })
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456')
    })
  })

  // 亮壁纸 + 深色主题的整窗可读性蒙版。只压暗四周面板的旧做法会把整窗裂成"中间白外层暗"的色带,
  // 所以这层必须是整窗一层,且只在"壁纸偏亮 + 深色主题"时才出现。
  describe('bgScrim(亮壁纸 + 深色主题的可读性蒙版)', () => {
    it('壁纸不亮时不上蒙版(深色壁纸下高可见度本来就能读)', () => {
      expect(bgScrim(0.85, false, true)).toBe(0)
    })
    it('浅色主题不上蒙版(深色字压亮壁纸本来就读得清)', () => {
      expect(bgScrim(0.85, true, false)).toBe(0)
    })
    it('可见度本来就低于上限时不介入', () => {
      expect(bgScrim(BRIGHT_WALLPAPER_CAP, true, true)).toBe(0)
      expect(bgScrim(0.2, true, true)).toBe(0)
    })
    it('把亮壁纸的【有效可见度】压到上限:bgOpacity×(1−scrim) === CAP', () => {
      for (const o of [0.5, 0.7, 0.85, 1]) {
        expect(o * (1 - bgScrim(o, true, true))).toBeCloseTo(BRIGHT_WALLPAPER_CAP, 2)
      }
    })
    it('可见度越高蒙版越厚,但永远不到全不透明', () => {
      expect(bgScrim(0.85, true, true)).toBeGreaterThan(bgScrim(0.5, true, true))
      expect(bgScrim(1, true, true)).toBeLessThan(1)
    })
    it('非法输入不产出 NaN', () => {
      expect(Number.isFinite(bgScrim(Number.NaN, true, true))).toBe(true)
    })
    it('applyTheme 只把明暗判定用于蒙版,不因此改配色(开关关着时 palette 不接管颜色)', () => {
      const wp = { ...base, bgImage: 'forge-bg://x.jpg', bgScope: 'app' as const, bgOpacity: 0.85, autoWallpaperTheme: false }
      applyTheme(wp, { base: 'light', hueBg: 200, chromaBg: 0.02, hueAccent: 90 })
      const r = document.documentElement
      expect(r.style.getPropertyValue('--app-bg-scrim')).toBe(String(bgScrim(0.85, true, true)))
      // 开关是关的 → 中性色不该被壁纸接管
      expect(r.style.getPropertyValue('--bg')).toBe('')
    })
    it('壁纸偏暗时 applyTheme 写 0', () => {
      const wp = { ...base, bgImage: 'forge-bg://x.jpg', bgScope: 'app' as const, bgOpacity: 0.85, autoWallpaperTheme: false }
      applyTheme(wp, { base: 'dark', hueBg: 200, chromaBg: 0.02, hueAccent: 90 })
      expect(document.documentElement.style.getPropertyValue('--app-bg-scrim')).toBe('0')
    })
  })

  it('resolves auto theme via prefers-color-scheme', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark'), media: q, addEventListener() {}, removeEventListener() {} }))
    applyTheme({ ...base, theme: 'auto' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    vi.unstubAllGlobals()
  })
})
