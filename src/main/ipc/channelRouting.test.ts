import { describe, it, expect, vi } from 'vitest'
import { CLIENT_ONLY, DAEMON_UNSUPPORTED, routeOf } from './channelRouting'
import { CH } from './channels'

vi.mock('electron', () => ({
  dialog: {}, shell: {}, app: { getVersion: () => '0', getPath: () => '/tmp' },
}))
vi.mock('../update/githubSource', () => ({
  fetchLatestRelease: async () => ({ version: '2.4.0', notes: 'n', assetUrl: 'u', assetSize: 6, assetName: 'a.dmg' }),
}))

import { registerIpc } from './handlers'
import { fakeHost } from '../host/fakeHost'

const table = () => registerIpc(() => {}, {}, fakeHost())

describe('频道分类', () => {
  it('CLIENT_ONLY 里的每一条都真的在方法表里 —— 拼错或过时会静默失效', () => {
    // 打错一个字符的后果是:那个 channel 悄悄变成走远程。外观类的东西一连过去就全变了,
    // 而且没有任何报错能指向这张表。
    const keys = new Set(Object.keys(table()))
    expect([...CLIENT_ONLY].filter((c) => !keys.has(c))).toEqual([])
  })

  it('DAEMON_UNSUPPORTED 里的每一条都真的在方法表里', () => {
    const keys = new Set(Object.keys(table()))
    expect([...DAEMON_UNSUPPORTED].filter((c) => !keys.has(c))).toEqual([])
  })

  it('两类加起来正好覆盖全表,且条数与今日实测一致', () => {
    // ★没列进 CLIENT_ONLY 的一律走 host。这条断言就是那个默认值的刹车:
    // 新加一个 channel 会让它挂,逼你当场决定归谁,而不是默默继承一个可能错的默认。
    const keys = Object.keys(table())
    const client = keys.filter((c) => routeOf(c) === 'client')
    const host = keys.filter((c) => routeOf(c) === 'host')
    expect(client.length).toBe(45)
    // 147 → 151:终端(term:create / write / resize / kill)。**shell 跑在 host 上** ——
    // 这是它们必须走 host 的全部理由,也正是这次改动要修的那个 bug。
    // 151 → 152:`chat:tool-output`。它按 (workspacePath, sessionId, messageId, toolId)
    //   去读主机上的会话文件,只有那台机器答得了 —— 所以是 host,不是 client。
    expect(host.length).toBe(152)
    expect(client.length + host.length).toBe(keys.length)
  })

  it('几条一眼就该对的:会话跟机器走,壁纸跟设备走', () => {
    expect(routeOf(CH.chatSend)).toBe('host')
    expect(routeOf(CH.workspacesList)).toBe('host')
    expect(routeOf(CH.run2Start)).toBe('host')
    expect(routeOf(CH.agentsDetect)).toBe('host')
    expect(routeOf(CH.wallpaperCatalog)).toBe('client')
    expect(routeOf(CH.updateCheck)).toBe('client')
    expect(routeOf(CH.openExternal)).toBe('client')
  })

  it('不认识的 channel 默认走 host(而不是当成本机静默吞掉)', () => {
    // 版本不一致时客户端可能发来我们没有的 channel。默认走 host → 对面报「没有这个方法」,
    // 是个能看见的错误;默认走 client → 本机也没有这个 handler,同样报错但指向错的一端。
    expect(routeOf('something:new')).toBe('host')
  })
})
