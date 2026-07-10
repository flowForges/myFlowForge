import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NotificationsPane } from './NotificationsPane'
import type { Notifications } from '@shared/types'

const notifications: Notifications = { enabled: true, confirm: true, input: true, done: false }

describe('NotificationsPane', () => {
  it('渲染「窗口」关闭行为三选并回写 closeAction', () => {
    const onCloseActionChange = vi.fn()
    render(<NotificationsPane notifications={notifications} onNotificationsChange={() => {}} closeAction="ask" onCloseActionChange={onCloseActionChange} />)
    const ask = screen.getByText('询问')
    expect(ask.className).toContain('on')
    expect(screen.getByText('缩小到 Dock')).toBeTruthy()
    expect(screen.getByText('退出应用')).toBeTruthy()
    fireEvent.click(screen.getByText('缩小到 Dock'))
    expect(onCloseActionChange).toHaveBeenCalledWith('hide')
    fireEvent.click(screen.getByText('退出应用'))
    expect(onCloseActionChange).toHaveBeenCalledWith('quit')
  })
  it('渲染系统通知开关并回写(总开关 + 逐类型)', () => {
    const onNotif = vi.fn()
    render(<NotificationsPane notifications={notifications} onNotificationsChange={onNotif} closeAction="ask" onCloseActionChange={() => {}} />)
    expect(screen.getByText('系统通知')).toBeTruthy()
    expect(screen.getByLabelText('需要确认时')).toBeTruthy()
    expect(screen.getByLabelText('执行完成时')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('执行完成时'))
    expect(onNotif).toHaveBeenCalledWith({ done: true })
  })
  it('总开关关闭时,逐类型开关禁用', () => {
    render(<NotificationsPane notifications={{ enabled: false, confirm: true, input: true, done: false }} onNotificationsChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} />)
    expect((screen.getByLabelText('需要确认时') as HTMLButtonElement).disabled).toBe(true)
  })
  it('closeAction=hide 时高亮「缩小到 Dock」', () => {
    render(<NotificationsPane notifications={notifications} onNotificationsChange={() => {}} closeAction="hide" onCloseActionChange={() => {}} />)
    expect(screen.getByText('缩小到 Dock').className).toContain('on')
    expect(screen.getByText('询问').className).not.toContain('on')
  })
})
