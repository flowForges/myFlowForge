import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SkinsPane } from './SkinsPane'
import { BUILTIN_SKINS } from '@shared/skins'
import type { Appearance } from '@shared/types'

// 无壁纸 → useWallpaperPalette 的 url 为空,直接返回 null,不会去解码图片。所以这里不用 mock canvas。
const base: Appearance = {
  theme: 'dark', accent: 'blue', autoWallpaperTheme: false, vibrancy: false, glass: false, windowOpacity: 1,
  blurAmount: 0, density: 'comfortable', fontSize: 14, chatFontSize: 14, chatLineHeight: 1.7, chatLetterSpacing: 0,
  chatInlineHtml: false, fontFamily: '', textWeight: 450, bgImage: '', bgScope: 'off', bgOpacity: 0.35,
  bgWallpaperId: '', homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35, bgPositions: {},
}
const first = BUILTIN_SKINS[0]
const second = BUILTIN_SKINS[1]
const cardFor = (name: string): HTMLElement => screen.getByTitle(new RegExp(`「${name}」`))
// 「跟随壁纸配色」现在整块就是一张卡(不再是右侧那个小开关),按可访问名字取。
const autoCard = (): HTMLElement => screen.getByRole('button', { name: /跟随壁纸配色/ })

describe('SkinsPane — 「跟随壁纸配色」与皮肤卡互斥,而不是一道前置开关', () => {
  it('「跟随壁纸配色」整块可点(不再需要去够右侧那个开关)', () => {
    const onChange = vi.fn()
    render(<SkinsPane appearance={{ ...base, bgImage: 'forge-bg://x.jpg', bgScope: 'app' }} onChange={onChange} />)
    // 面板里除了它自己不该再有一个单独的开关控件
    expect(screen.queryByLabelText('跟随壁纸配色')).toBeNull()
    fireEvent.click(autoCard())
    expect(onChange).toHaveBeenCalledWith({ autoWallpaperTheme: true, activeSkin: null })
  })

  it('没有壁纸时这张卡不可点(取不到色)', () => {
    render(<SkinsPane appearance={base} onChange={() => {}} />)
    expect(autoCard()).toBeDisabled()
  })

  it('选中态用 aria-pressed 表达,和皮肤卡一致', () => {
    const { rerender } = render(<SkinsPane appearance={{ ...base, bgImage: 'forge-bg://x.jpg', bgScope: 'app' }} onChange={() => {}} />)
    expect(autoCard()).toHaveAttribute('aria-pressed', 'false')
    rerender(<SkinsPane appearance={{ ...base, bgImage: 'forge-bg://x.jpg', bgScope: 'app', autoWallpaperTheme: true }} onChange={() => {}} />)
    expect(autoCard()).toHaveAttribute('aria-pressed', 'true')
  })

  it('跟随壁纸开着时,皮肤卡仍可点击(不再 disabled)', () => {
    render(<SkinsPane appearance={{ ...base, autoWallpaperTheme: true }} onChange={() => {}} />)
    expect(cardFor(first.name)).not.toBeDisabled()
  })

  it('跟随壁纸开着时点一张皮肤卡 = 选中它 + 自动关掉跟随壁纸(一次点击,不用先取消)', () => {
    const onChange = vi.fn()
    render(<SkinsPane appearance={{ ...base, autoWallpaperTheme: true }} onChange={onChange} />)
    fireEvent.click(cardFor(second.name))
    expect(onChange).toHaveBeenCalledWith({ activeSkin: second.id, autoWallpaperTheme: false })
  })

  it('跟随壁纸开着时,画廊里不该有任何一张卡显示为选中(生效的是壁纸配色)', () => {
    render(<SkinsPane appearance={{ ...base, autoWallpaperTheme: true, activeSkin: first.id }} onChange={() => {}} />)
    for (const s of BUILTIN_SKINS) expect(cardFor(s.name)).toHaveAttribute('aria-pressed', 'false')
  })

  it('打开跟随壁纸时清掉手选皮肤(否则画廊亮着一张、生效的却是另一套)', () => {
    const onChange = vi.fn()
    render(<SkinsPane appearance={{ ...base, activeSkin: first.id, bgImage: 'forge-bg://x.jpg', bgScope: 'app' }} onChange={onChange} />)
    fireEvent.click(autoCard())
    expect(onChange).toHaveBeenCalledWith({ autoWallpaperTheme: true, activeSkin: null })
  })

  it('关掉跟随壁纸不动 activeSkin(它此刻本来就是空的)', () => {
    const onChange = vi.fn()
    render(<SkinsPane appearance={{ ...base, autoWallpaperTheme: true, bgImage: 'forge-bg://x.jpg', bgScope: 'app' }} onChange={onChange} />)
    fireEvent.click(autoCard())
    expect(onChange).toHaveBeenCalledWith({ autoWallpaperTheme: false })
  })

  it('没开跟随壁纸时,再点已选中的那张 = 取消皮肤', () => {
    const onChange = vi.fn()
    render(<SkinsPane appearance={{ ...base, activeSkin: first.id }} onChange={onChange} />)
    expect(cardFor(first.name)).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(cardFor(first.name))
    expect(onChange).toHaveBeenCalledWith({ activeSkin: null })
  })

  it('没开跟随壁纸时,点另一张 = 换成那张', () => {
    const onChange = vi.fn()
    render(<SkinsPane appearance={{ ...base, activeSkin: first.id }} onChange={onChange} />)
    fireEvent.click(cardFor(second.name))
    expect(onChange).toHaveBeenCalledWith({ activeSkin: second.id, autoWallpaperTheme: false })
  })
})
