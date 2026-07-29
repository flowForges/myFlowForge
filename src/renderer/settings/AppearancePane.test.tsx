import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppearancePane } from './AppearancePane'
import type { Appearance, Terminal } from '@shared/types'

const appearance: Appearance = { theme: 'dark', accent: 'blue', vibrancy: false, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 14, chatFontSize: 14, chatLineHeight: 1.7, chatLetterSpacing: 0, fontFamily: '', textWeight: 450, bgImage: '', bgScope: 'off', bgOpacity: 0.35, bgWallpaperId: '', homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35 }
const terminal: Terminal = { fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 }

describe('AppearancePane', () => {
  it('reflects current appearance and reports changes', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    fireEvent.click(screen.getByText('浅色'))
    expect(onChange).toHaveBeenCalledWith({ theme: 'light' })
    // 应用字号 is now a numeric px input.
    fireEvent.change(screen.getByLabelText('应用字号'), { target: { value: '11.5' } })
    expect(onChange).toHaveBeenCalledWith({ fontSize: 11.5 })
  })
  it('会话区字号 独立回写 chatFontSize', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    fireEvent.change(screen.getByLabelText('会话区字号'), { target: { value: '12' } })
    expect(onChange).toHaveBeenCalledWith({ chatFontSize: 12 })
  })
  it('renders the 窗口透明度 slider and reports windowOpacity changes', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    expect(screen.getByText('窗口透明度')).toBeTruthy()
    const slider = screen.getByLabelText('窗口透明度') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.8' } })
    expect(onChange).toHaveBeenCalledWith({ windowOpacity: 0.8 })
  })
  it('渲染「磨砂度」滑块并回写 blurAmount', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    expect(screen.getByText('磨砂度')).toBeTruthy()
    const slider = screen.getByLabelText('磨砂度') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.5' } })
    expect(onChange).toHaveBeenCalledWith({ blurAmount: 0.5 })
  })
  it('渲染「应用字体」选择器,手动输入回写 fontFamily', () => {
    const onChange = vi.fn()
    const { container } = render(<AppearancePane appearance={appearance} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    // Open the font picker (its trigger, not the 跟随系统 theme card), reveal the advanced manual input, type.
    fireEvent.click(container.querySelector('.fp-trigger') as HTMLElement)
    fireEvent.click(screen.getByText('手动输入字体族(高级)'))
    const input = screen.getByPlaceholderText("如: 'PingFang SC', 'Inter', sans-serif") as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Inter' } })
    expect(onChange).toHaveBeenCalledWith({ fontFamily: 'Inter' })
  })
  it('「文本字重」滑块回写数值,并可一键恢复建议值', () => {
    const onChange = vi.fn()
    // 起始为一个非建议值,验证滑块显示它、且「恢复」按钮写回 450。
    render(<AppearancePane appearance={{ ...appearance, textWeight: 500 }} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    const slider = screen.getByLabelText('文本字重') as HTMLInputElement
    expect(slider.value).toBe('500')
    fireEvent.change(slider, { target: { value: '350' } })
    expect(onChange).toHaveBeenCalledWith({ textWeight: 350 })
    // 数值按钮点一下恢复到建议字重 450
    fireEvent.click(screen.getByText('500'))
    expect(onChange).toHaveBeenCalledWith({ textWeight: 450 })
  })
})
