import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (...a: any[]) => any> = {}
vi.mock('electron', () => ({
  dialog: {},
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp' },
  shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
}))

// 让 checker 用假 source：始终返回一个更新
vi.mock('../update/githubSource', () => ({
  fetchLatestRelease: async () => ({ version: '2.4.0', notes: 'n', assetUrl: 'u', assetSize: 6, assetName: 'a.dmg' }),
}))

import { registerIpc } from './handlers'
import { CH } from './channels'
import { tableCalls } from './testTable'

// registerIpc 不再往 ipcMain 上挂,而是返回方法表;这里摊平后填进原来的 handlers 表,
// 下面的调用点(`handlers[CH.updateGet]()`)一行不用改。
function install(...a: Parameters<typeof registerIpc>) {
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const [ch, fn] of tableCalls(registerIpc(...a))) handlers[ch] = fn
}

beforeEach(() => { for (const k of Object.keys(handlers)) delete handlers[k] })

describe('update IPC', () => {
  it('update:get returns current version and (initially) no info', async () => {
    install(() => {}, {})
    const res = await handlers[CH.updateGet]()
    expect(res.currentVersion).toBe('1.0.0')
    expect(res.info).toBeNull()
  })
  it('update:check broadcasts update:available after a manual check', async () => {
    const broadcast = vi.fn()
    install(broadcast, {})
    await handlers[CH.updateCheck]()
    // check 是异步触发的，await 一个微任务循环
    await new Promise(r => setTimeout(r, 0))
    expect(broadcast).toHaveBeenCalledWith(CH.updateAvailable, { info: expect.objectContaining({ version: '2.4.0' }) })
  })
})
