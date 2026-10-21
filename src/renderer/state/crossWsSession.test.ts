import { describe, it, expect, vi } from 'vitest'
import { switchToSessionInOtherWorkspace } from './crossWsSession'

describe('switchToSessionInOtherWorkspace —— 点别的工作区下的第 N 条会话', () => {
  it('★★记成这台设备的选择(界面认的是它,不是主机那份)', async () => {
    const remember = vi.fn()
    await switchToSessionInOtherWorkspace('/ws/b', 's2', { remember, sessionSwitch: async () => {}, openWorkspace: vi.fn() })
    expect(remember).toHaveBeenCalledWith('/ws/b', 's2')
  })

  it('★顺序:记住选择 → 等主机切好 → 再切工作区', async () => {
    const order: string[] = []
    let release!: () => void
    const sessionSwitch = vi.fn(() => new Promise<void>((r) => { release = () => { order.push('switched'); r() } }))
    const p = switchToSessionInOtherWorkspace('/ws/b', 's2', {
      remember: () => order.push('remember'),
      sessionSwitch,
      openWorkspace: () => order.push('open'),
    })
    await Promise.resolve()
    expect(sessionSwitch).toHaveBeenCalledWith({ workspacePath: '/ws/b', sessionId: 's2' })
    expect(order).toEqual(['remember'])
    release()
    await p
    expect(order).toEqual(['remember', 'switched', 'open'])
  })

  it('切换失败也照样打开那个工作区,不卡在原地', async () => {
    const openWorkspace = vi.fn()
    await switchToSessionInOtherWorkspace('/ws/b', 'gone', { remember: vi.fn(), sessionSwitch: async () => { throw new Error('no such session') }, openWorkspace })
    expect(openWorkspace).toHaveBeenCalledWith('/ws/b')
  })

  it('没有 sessionSwitch(老 preload):记住后直接打开', async () => {
    const openWorkspace = vi.fn()
    await switchToSessionInOtherWorkspace('/ws/b', 's2', { remember: vi.fn(), openWorkspace })
    expect(openWorkspace).toHaveBeenCalledWith('/ws/b')
  })
})
