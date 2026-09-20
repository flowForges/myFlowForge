import { describe, it, expect, afterEach } from 'vitest'
import { applyTheme, bgBlurPx, BG_BLUR_MAX } from './applyTheme'
import { initWindowFocus } from './windowFocus'
import type { Appearance } from '@shared/types'

/**
 * 壁纸【自身】的模糊(2026-09-08)。
 *
 * ★★字读不读得清,取决于底下有没有【高频细节】,不只是底有多亮。把壁纸糊掉,颜色和构图都还在,
 *  但没有细节再和字形抢边缘 —— 这就是终端类 app「玻璃底 + 字很锐」的做法。
 * ★和「磨砂度」(blurAmount)不是一回事:那个是 macOS 原生 vibrancy,模糊的是【窗口背后的桌面】。
 * ★只在窗口是焦点时糊:你在读字才需要它;切走了壁纸就该恢复清晰(用户点名要的 cmux 行为)。
 */

const base: Appearance = {
  theme: 'dark', accent: 'blue', autoWallpaperTheme: false, vibrancy: false, glass: false,
  windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 14, chatFontSize: 14,
  chatLineHeight: 1.7, chatLetterSpacing: 0, chatInlineHtml: false, fontFamily: '', textWeight: 450,
  bgImage: '', bgScope: 'off', bgOpacity: 0.35, bgBlur: 0, bgWallpaperId: '',
  homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35, bgPositions: {}, hostChip: 'both',
}
const cssVar = (n: string) => document.documentElement.style.getPropertyValue(n)

afterEach(() => { document.documentElement.removeAttribute('data-win-focus') })

describe('bgBlurPx', () => {
  it('0..1 线性映射到 0..上限', () => {
    expect(bgBlurPx(0)).toBe(0)
    expect(bgBlurPx(1)).toBe(BG_BLUR_MAX)
    expect(bgBlurPx(0.5)).toBe(BG_BLUR_MAX / 2)
  })
  it('★越界和非数字一律夹回来 —— 手改配置文件写个 5 进去不该糊成一片', () => {
    expect(bgBlurPx(5)).toBe(BG_BLUR_MAX)
    expect(bgBlurPx(-2)).toBe(0)
    expect(bgBlurPx(NaN as number)).toBe(0)
    expect(bgBlurPx(undefined as unknown as number)).toBe(0)
  })
})

describe('applyTheme 写出模糊相关的变量', () => {
  it('关着的时候是 0px,并且不留任何溢出', () => {
    applyTheme({ ...base, bgBlur: 0 })
    expect(cssVar('--app-bg-blur')).toBe('0px')
    expect(cssVar('--app-bg-bleed')).toBe('0px')
  })

  it('★★开着的时候必须同时给出【负的】溢出 —— 只糊不溢,四条边会出现一圈淡出的晕', () => {
    applyTheme({ ...base, bgBlur: 0.5 })
    expect(cssVar('--app-bg-blur')).toBe(`${BG_BLUR_MAX / 2}px`)
    const bleed = parseFloat(cssVar('--app-bg-bleed'))
    expect(bleed).toBeLessThan(0)
    // 溢出要比模糊半径还大,否则晕仍然会露在可视区里
    expect(Math.abs(bleed)).toBeGreaterThan(BG_BLUR_MAX / 2)
  })
})

describe('initWindowFocus', () => {
  it('★挂上去的当下就要定初值 —— 只等事件的话,启动时不在前台的那一帧是错的', () => {
    const off = initWindowFocus()
    expect(document.documentElement.getAttribute('data-win-focus')).toMatch(/^(on|off)$/)
    off()
  })

  it('★★focus / blur 来回切换要跟着变 —— 这就是「切走恢复清晰」的开关', () => {
    const off = initWindowFocus()
    window.dispatchEvent(new Event('blur'))
    expect(document.documentElement.getAttribute('data-win-focus')).toBe('off')
    window.dispatchEvent(new Event('focus'))
    expect(document.documentElement.getAttribute('data-win-focus')).toBe('on')
    off()
  })

  it('★卸载之后不再改属性 —— 漏摘监听会在窗口重建后越挂越多', () => {
    const off = initWindowFocus()
    window.dispatchEvent(new Event('focus'))
    off()
    window.dispatchEvent(new Event('blur'))
    expect(document.documentElement.getAttribute('data-win-focus')).toBe('on')
  })
})
