import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppearancePane } from './AppearancePane'
import type { Appearance, Terminal, Notifications } from '@shared/types'

const appearance: Appearance = { theme: 'dark', accent: 'blue', vibrancy: false, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 'medium' }
const notifications: Notifications = { enabled: true, confirm: true, input: true, done: false }
const terminal: Terminal = { fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 }

describe('AppearancePane', () => {
  it('reflects current appearance and reports changes', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} notifications={notifications} onNotificationsChange={() => {}} terminal={terminal} onTerminalChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} />)
    fireEvent.click(screen.getByText('浅色'))
    expect(onChange).toHaveBeenCalledWith({ theme: 'light' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'large' } })
    expect(onChange).toHaveBeenCalledWith({ fontSize: 'large' })
  })
  it('renders the 窗口透明度 slider and reports windowOpacity changes', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} notifications={notifications} onNotificationsChange={() => {}} terminal={terminal} onTerminalChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} />)
    expect(screen.getByText('窗口透明度')).toBeTruthy()
    const slider = screen.getByLabelText('窗口透明度') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.8' } })
    expect(onChange).toHaveBeenCalledWith({ windowOpacity: 0.8 })
  })
  it('渲染「磨砂度」滑块并回写 blurAmount', () => {
    const onChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={onChange} notifications={notifications} onNotificationsChange={() => {}} terminal={terminal} onTerminalChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} />)
    expect(screen.getByText('磨砂度')).toBeTruthy()
    const slider = screen.getByLabelText('磨砂度') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.5' } })
    expect(onChange).toHaveBeenCalledWith({ blurAmount: 0.5 })
  })
  it('渲染「窗口」关闭行为三选并回写 closeAction', () => {
    const onCloseActionChange = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={() => {}} notifications={notifications} onNotificationsChange={() => {}} terminal={terminal} onTerminalChange={() => {}} closeAction="ask" onCloseActionChange={onCloseActionChange} />)
    // 三个选项都渲染,当前值高亮
    const ask = screen.getByText('询问')
    expect(ask.className).toContain('on')
    expect(screen.getByText('缩小到 Dock')).toBeTruthy()
    expect(screen.getByText('退出应用')).toBeTruthy()
    // 点击回写
    fireEvent.click(screen.getByText('缩小到 Dock'))
    expect(onCloseActionChange).toHaveBeenCalledWith('hide')
    fireEvent.click(screen.getByText('退出应用'))
    expect(onCloseActionChange).toHaveBeenCalledWith('quit')
  })
  it('渲染系统通知开关并回写(总开关 + 逐类型)', () => {
    const onNotif = vi.fn()
    render(<AppearancePane appearance={appearance} onChange={() => {}} notifications={notifications} onNotificationsChange={onNotif} terminal={terminal} onTerminalChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} />)
    expect(screen.getByText('系统通知')).toBeTruthy()
    // 逐类型开关渲染
    expect(screen.getByLabelText('需要确认时')).toBeTruthy()
    expect(screen.getByLabelText('执行完成时')).toBeTruthy()
    // 点「执行完成时」回写(默认关 → 开)
    fireEvent.click(screen.getByLabelText('执行完成时'))
    expect(onNotif).toHaveBeenCalledWith({ done: true })
  })
  it('总开关关闭时,逐类型开关禁用', () => {
    render(<AppearancePane appearance={appearance} onChange={() => {}} notifications={{ enabled: false, confirm: true, input: true, done: false }} onNotificationsChange={() => {}} terminal={terminal} onTerminalChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} />)
    expect((screen.getByLabelText('需要确认时') as HTMLButtonElement).disabled).toBe(true)
  })
  it('closeAction=hide 时高亮「缩小到 Dock」', () => {
    render(<AppearancePane appearance={appearance} onChange={() => {}} notifications={notifications} onNotificationsChange={() => {}} terminal={terminal} onTerminalChange={() => {}} closeAction="hide" onCloseActionChange={() => {}} />)
    expect(screen.getByText('缩小到 Dock').className).toContain('on')
    expect(screen.getByText('询问').className).not.toContain('on')
  })
})
