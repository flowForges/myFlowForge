import { describe, it, expect, vi } from 'vitest'
import { CLIENT_ONLY, DAEMON_UNSUPPORTED, daemonTable } from './channelRouting'

vi.mock('electron', () => ({ dialog: {}, shell: {}, app: { getVersion: () => '0', getPath: () => '/tmp' } }))
vi.mock('../update/githubSource', () => ({
  fetchLatestRelease: async () => ({ version: '2.4.0', notes: 'n', assetUrl: 'u', assetSize: 6, assetName: 'a.dmg' }),
}))
import { registerIpc } from './handlers'
import { fakeHost } from '../host/fakeHost'

describe('daemonTable', () => {
  const full = () => registerIpc(() => {}, {}, fakeHost())

  it('剔掉跟设备走的和无头做不了的,剩下的就是握手时发出去的方法清单', () => {
    const t = daemonTable(full())
    const keys = Object.keys(t)
    expect(keys.length).toBe(187 - 45 - 2)
    for (const c of CLIENT_ONLY) expect(keys).not.toContain(c)
    for (const c of DAEMON_UNSUPPORTED) expect(keys).not.toContain(c)
  })

  it('会话、工作区、agent 这些核心能力都还在', () => {
    const keys = new Set(Object.keys(daemonTable(full())))
    for (const c of ['chat:send', 'chat:history', 'workspaces:list', 'session:list', 'agents:detect', 'run2:start', 'git:changes']) {
      expect(keys.has(c), `${c} 应该由 daemon 提供`).toBe(true)
    }
  })

  it('壁纸、更新、宠物这些不该由 daemon 提供', () => {
    const keys = new Set(Object.keys(daemonTable(full())))
    for (const c of ['wallpaper:catalog', 'update:start', 'pet:pick-image', 'nsfw:catalog', 'openers:open']) {
      expect(keys.has(c), `${c} 不该由 daemon 提供`).toBe(false)
    }
  })

  it('原表不被改动(daemonTable 得是个新表,Electron 那边还要用完整的)', () => {
    const f = full()
    const before = Object.keys(f).length
    daemonTable(f)
    expect(Object.keys(f).length).toBe(before)
  })
})
