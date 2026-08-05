import { describe, it, expect, afterEach, vi } from 'vitest'
import { applyTheme, onAccentFor } from './applyTheme'
import type { Appearance } from '@shared/types'

const base: Appearance = { theme: 'dark', accent: 'blue', vibrancy: true, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 14, chatFontSize: 14, chatLineHeight: 1.7, chatLetterSpacing: 0, fontFamily: '', textWeight: 450, bgImage: '', bgScope: 'off', bgOpacity: 0.35, bgWallpaperId: '', homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35, bgPositions: {} }
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
  it('resolves auto theme via prefers-color-scheme', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark'), media: q, addEventListener() {}, removeEventListener() {} }))
    applyTheme({ ...base, theme: 'auto' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    vi.unstubAllGlobals()
  })
})
