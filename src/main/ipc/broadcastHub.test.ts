import { describe, it, expect, vi } from 'vitest'
import { createBroadcastHub } from './broadcastHub'

describe('createBroadcastHub', () => {
  it('把一条广播发给所有 sink', () => {
    const hub = createBroadcastHub()
    const a = vi.fn(); const b = vi.fn()
    hub.addSink(a); hub.addSink(b)
    hub.broadcast('chat:event', { id: 1 })
    expect(a).toHaveBeenCalledWith('chat:event', { id: 1 })
    expect(b).toHaveBeenCalledWith('chat:event', { id: 1 })
  })

  it('addSink 返回的退订函数真的把它摘掉', () => {
    const hub = createBroadcastHub()
    const a = vi.fn()
    hub.addSink(a)()
    hub.broadcast('chat:event', {})
    expect(a).not.toHaveBeenCalled()
    expect(hub.sinkCount()).toBe(0)
  })

  it('退订函数重复调用不会误伤后来重新注册的同一个函数', () => {
    // 断线重连时同一个 sink 函数会被重新挂上,而旧的退订闭包还攥在别人手里。
    // 按【函数身份】删会把新注册的那份一起删掉 —— 那个客户端从此静默收不到任何事件,
    // 而且没有任何报错。所以退订必须按【令牌】。
    const hub = createBroadcastHub()
    const a = vi.fn()
    const off = hub.addSink(a)
    off()
    hub.addSink(a)   // 重连,重新挂上
    off()            // 旧闭包被谁又调了一次
    hub.broadcast('chat:event', {})
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('一个 sink 抛异常不能连坐其它 sink', () => {
    // 远程客户端的 socket 随时可能在写入的那一瞬间断掉。它抛出来若不接住,
    // 排在后面的本机窗口就收不到这条事件 —— 界面凭空卡住,且看不出跟网络有关。
    const hub = createBroadcastHub()
    const boom = vi.fn(() => { throw new Error('socket closed') })
    const ok = vi.fn()
    hub.addSink(boom); hub.addSink(ok)
    expect(() => hub.broadcast('chat:event', {})).not.toThrow()
    expect(ok).toHaveBeenCalled()
  })

  it('sink 在广播过程中退订自己,不影响这一轮的其它 sink', () => {
    // 「写失败 → 就地摘掉自己」是远程 sink 的自然写法,而边遍历边改集合是经典的漏发。
    const hub = createBroadcastHub()
    const seen: string[] = []
    const off = hub.addSink(() => { seen.push('first'); off() })
    hub.addSink(() => seen.push('second'))
    hub.broadcast('chat:event', {})
    expect(seen).toEqual(['first', 'second'])
    expect(hub.sinkCount()).toBe(1)
  })
})
