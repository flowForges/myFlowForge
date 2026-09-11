import { describe, it, expect, vi } from 'vitest'
import { CH } from './channels'

/**
 * 「检测出口 IP」有两个按钮(agent 的出口 / app 自身的网络),它们必须问**两条不同的代理**。
 *
 * 2026-09-11 用户报「设置里有两套一模一样的设置代理和检查出口」。查下来不只是长得像:
 * 主进程只有一条 `net:check-exit-ip`,无论哪个按钮点的都答 `agentProxy` —— 第二块面板给出的
 * 出口 IP 是**假的**。这是那类最难发现的 bug:它不报错,只是把另一条链路的结果摆在你面前,
 * 让你以为"验过了"。
 */
const PROXIES = { agentProxy: 'http://agent-proxy:1', appProxy: 'http://app-proxy:2' }

vi.mock('electron', () => ({
  dialog: {}, shell: {}, app: { getVersion: () => '0', getPath: () => '/tmp' },
}))
vi.mock('../update/githubSource', () => ({
  fetchLatestRelease: async () => ({ version: '0', notes: '', assetUrl: '', assetSize: 0, assetName: '' }),
}))
vi.mock('../config/store', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const readSettings = actual.readSettings as () => Record<string, unknown>
  return { ...actual, readSettings: () => ({ ...readSettings(), ...PROXIES }) }
})
// 回声实现:把收到的代理原样当成 ip 返回,于是断言直接看得见"问的是哪一条"。
vi.mock('../net/exitIp', () => ({
  checkExitIp: vi.fn(async (proxy: string) => ({ ip: proxy, region: '', via: proxy ? 'proxy' : 'direct' })),
}))

import { registerIpc } from './handlers'
import { fakeHost } from '../host/fakeHost'
import { NOOP_CTX } from './invokeCtx'

describe('出口 IP 检测按 scope 分两条', () => {
  const call = async (ch: string) => {
    const table = registerIpc(() => {}, {}, fakeHost())
    return await (table[ch] as (ctx: unknown) => Promise<{ ip: string }>)(NOOP_CTX)
  }

  it('agent 那条问 agentProxy', async () => {
    expect((await call(CH.netCheckExitIp)).ip).toBe(PROXIES.agentProxy)
  })

  it('★app 那条必须问 appProxy —— 原先它也答 agentProxy,结果是假的', async () => {
    expect((await call(CH.netCheckAppExitIp)).ip).toBe(PROXIES.appProxy)
  })
})
