import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppearancePane } from './AppearancePane'
import type { Appearance, Terminal } from '@shared/types'

const appearance: Appearance = { theme: 'dark', accent: 'blue', vibrancy: false, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 'medium', chatFontSize: 'medium', fontFamily: '', textWeight: 'medium', bgImage: '', bgScope: 'off', bgOpacity: 0.35, homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35 }
const terminal: Terminal = { fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 }

describe('AppearancePane', () => {
  it('reflects current appearance and reports changes', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    fireEvent.click(screen.getByText('浅色'))
    expect(onChange).toHaveBeenCalledWith({ theme: 'light' })
    // 应用字号 and 会话区字号 are both 小/中/大 segmented rows; the first '大' is the app font size.
    fireEvent.click(screen.getAllByText('大')[0])
    expect(onChange).toHaveBeenCalledWith({ fontSize: 'large' })
  })
  it('会话区字号 独立回写 chatFontSize', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    // Second 小/中/大 row = 会话区字号.
    fireEvent.click(screen.getAllByText('大')[1])
    expect(onChange).toHaveBeenCalledWith({ chatFontSize: 'large' })
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
  it('渲染「文本字重」两选并回写 textWeight', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} terminal={terminal} onTerminalChange={() => {}} />)
    // 默认 medium 高亮
    expect(screen.getByText('适中(更清晰)').className).toContain('on')
    fireEvent.click(screen.getByText('标准'))
    expect(onChange).toHaveBeenCalledWith({ textWeight: 'normal' })
  })
})
