import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NotificationsPane } from './NotificationsPane'
import type { Notifications, NotifyEvents } from '@shared/types'

const notifications: Notifications = { enabled: true, confirm: true, input: true, done: false }
// Q1 拆分后的另一半:「这台机器上哪些事件值得产生通知」。
const notifyEvents: NotifyEvents = { confirm: true, input: true, done: true }
const evProps = { notifyEvents, onNotifyEventsChange: () => {} }

describe('NotificationsPane', () => {
  it('渲染「窗口」关闭行为三选并回写 closeAction', () => {
    const onCloseActionChange = vi.fn()
    render(<NotificationsPane notifications={notifications} onNotificationsChange={() => {}} closeAction="ask" onCloseActionChange={onCloseActionChange} {...evProps} />)
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
    render(<NotificationsPane notifications={notifications} onNotificationsChange={onNotif} closeAction="ask" onCloseActionChange={() => {}} {...evProps} />)
    expect(screen.getByText('系统通知')).toBeTruthy()
    expect(screen.getByLabelText('需要确认时')).toBeTruthy()
    expect(screen.getByLabelText('执行完成时')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('执行完成时'))
    expect(onNotif).toHaveBeenCalledWith({ done: true })
  })
  it('总开关关闭时,逐类型开关禁用', () => {
    render(<NotificationsPane notifications={{ enabled: false, confirm: true, input: true, done: false }} onNotificationsChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} {...evProps} />)
    expect((screen.getByLabelText('需要确认时') as HTMLButtonElement).disabled).toBe(true)
  })
  it('closeAction=hide 时高亮「缩小到 Dock」', () => {
    render(<NotificationsPane notifications={notifications} onNotificationsChange={() => {}} closeAction="hide" onCloseActionChange={() => {}} {...evProps} />)
    expect(screen.getByText('缩小到 Dock').className).toContain('on')
    expect(screen.getByText('询问').className).not.toContain('on')
  })

  it('★两段是分开的:设备这段叫「收哪些」,机器那段叫「哪些值得通知」', () => {
    // Q1 的整个意义就在这儿:一个是设备偏好(手机只想收要我答门的),
    // 一个是机器上的事实(这台机器上一轮跑完算不算一件值得通知的事)。混成一个开关就没法各管各的。
    render(<NotificationsPane notifications={notifications} onNotificationsChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} {...evProps} hostLabel="云服务器" />)
    expect(screen.getByText(/这台设备收哪些/)).toBeTruthy()
    expect(screen.getByText(/哪些事件值得通知/)).toBeTruthy()
    // 标题和说明里都提到了机器名 —— 这正是「说清是哪台」的意思,所以用 getAllByText。
    expect(screen.getAllByText(/云服务器/).length).toBeGreaterThan(0)
  })
  it('机器那段的开关回写的是 notifyEvents,不是 notifications', () => {
    const onEv = vi.fn()
    const onNotif = vi.fn()
    render(<NotificationsPane notifications={notifications} onNotificationsChange={onNotif} closeAction="ask" onCloseActionChange={() => {}} notifyEvents={notifyEvents} onNotifyEventsChange={onEv} />)
    fireEvent.click(screen.getByLabelText('执行完成时(事件)'))
    expect(onEv).toHaveBeenCalledWith({ done: false })
    expect(onNotif).not.toHaveBeenCalled()
  })
  it('设备那段的总开关关掉,不影响机器那段(它们本来就不是一件事)', () => {
    render(<NotificationsPane notifications={{ enabled: false, confirm: true, input: true, done: false }} onNotificationsChange={() => {}} closeAction="ask" onCloseActionChange={() => {}} {...evProps} />)
    expect((screen.getByLabelText('需要确认时') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('需要确认时(事件)') as HTMLButtonElement).disabled).toBe(false)
  })
})
