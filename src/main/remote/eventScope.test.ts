import { describe, it, expect, vi } from 'vitest'
import { scopeEventForRemoteClient, remoteAddSink } from './eventScope'

describe('发给远程客户端的那一路广播', () => {
  /**
   * ★★主机推 `settings:changed` 时推的是 `readSettings()` 的**整份**设置,一半是「跟设备走」的
   *  (主题、壁纸、宠物、这台电脑对手机开不开门)。客户端会把它存进自己的快照 ——
   *  于是主机的外观会悄悄同化掉手机/另一台电脑的外观。每一半设置,只有拥有它的那台机器有资格往外说。
   */
  it('★settings:changed 只把「跟机器走」的那一半发出去', () => {
    const out = scopeEventForRemoteClient('settings:changed', {
      agentProxy: 'http://127.0.0.1:7897',
      disabledProviders: ['qoder'],
      appearance: { theme: 'dark' },
      pet: { enabled: true },
      appProxy: 'http://127.0.0.1:7897',
      mobileGateway: { enabled: true, host: '0.0.0.0', port: 6789 },
    }) as Record<string, unknown>

    expect(out.agentProxy).toBe('http://127.0.0.1:7897')
    expect(out.disabledProviders).toEqual(['qoder'])   // 手机端只从这条事件里读它
    expect(out).not.toHaveProperty('appearance')
    expect(out).not.toHaveProperty('pet')
    expect(out).not.toHaveProperty('appProxy')
    expect(out).not.toHaveProperty('mobileGateway')
  })

  it('别的事件原样过去', () => {
    const payload = { workspacePath: '/ws', text: 'hi' }
    expect(scopeEventForRemoteClient('chat:event', payload)).toBe(payload)
  })

  it('不是对象的负载不动它(不能在广播路上抛异常)', () => {
    expect(scopeEventForRemoteClient('settings:changed', null)).toBe(null)
    expect(scopeEventForRemoteClient('settings:changed', 'x')).toBe('x')
  })

  it('remoteAddSink 包住的 sink 拿到的是收窄后的负载,且解绑照常', () => {
    const sink = vi.fn()
    const off = vi.fn()
    const addSink = vi.fn((s: (c: string, p: unknown) => void) => { s('settings:changed', { agentProxy: 'p', appearance: {} }); return off })

    const detach = remoteAddSink(addSink)(sink)
    expect(sink).toHaveBeenCalledWith('settings:changed', { agentProxy: 'p' })
    expect(detach).toBe(off)
  })
})
