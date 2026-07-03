import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (...a: any[]) => any> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { handlers[ch] = fn } },
  dialog: {},
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp' },
  shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
}))

// 让 checker 用假 source：始终返回一个更新
vi.mock('../update/githubSource', () => ({
  fetchLatestRelease: async () => ({ version: '2.4.0', notes: 'n', dmgUrl: 'u', dmgSize: 6, dmgName: 'a.dmg' }),
}))

import { registerIpc } from './handlers'
import { CH } from './channels'

beforeEach(() => { for (const k of Object.keys(handlers)) delete handlers[k] })

describe('update IPC', () => {
  it('update:get returns current version and (initially) no info', async () => {
    registerIpc(() => {}, {})
    const res = await handlers[CH.updateGet]()
    expect(res.currentVersion).toBe('1.0.0')
    expect(res.info).toBeNull()
  })
  it('update:check broadcasts update:available after a manual check', async () => {
    const broadcast = vi.fn()
    registerIpc(broadcast, {})
    await handlers[CH.updateCheck]()
    // check 是异步触发的，await 一个微任务循环
    await new Promise(r => setTimeout(r, 0))
    expect(broadcast).toHaveBeenCalledWith(CH.updateAvailable, { info: expect.objectContaining({ version: '2.4.0' }) })
  })
})
