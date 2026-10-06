import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectRouted } from './routedClient'
import type { ConnectOpts, HostClient, HostState } from './hostClient'
import { freshMemory, LAN_CONNECT_BUDGET_MS, LAN_PROBE_BUDGET_MS, LAN_COOLDOWN_MS } from '../../../src/shared/remote/routePick'

// 一个假的 connectHost:记下每次拨的是哪条路,测试手动推动它的状态。
type Fake = { opts: ConnectOpts; route: 'lan' | 'relay'; set: (s: HostState) => void; closed: boolean; event: (ch: string, p: unknown) => void; invoke: (ch: string, args?: unknown[]) => Promise<unknown> }
let dials: Fake[]
const READY: HostState = { status: 'ready', version: '1.2.4', methods: new Set(['x']) }

function fakeConnect(opts: ConnectOpts): HostClient {
  let st: HostState = { status: 'connecting', attempt: 1 }
  const waiters = new Set<(s: HostState) => void>()
  const f: Fake = {
    opts, route: opts.relayUrl ? 'relay' : 'lan', closed: false,
    set: (s) => { st = s; opts.onState?.(s); for (const w of [...waiters]) w(s) },
    event: (ch, p) => opts.onEvent(ch, p),
    invoke: vi.fn(async (ch: string) => `${opts.relayUrl ? 'relay' : 'lan'}:${ch}`),
  }
  dials.push(f)
  return {
    state: () => st,
    onState: (cb) => { waiters.add(cb); return () => waiters.delete(cb) },
    invoke: (ch, args) => f.invoke(ch, args),
    // ★和真的 connectHost 一样:close() 会**同步**报一次 closed。包装层要能分清
    //  「我自己收掉的」和「它自己断掉的」,否则一次主动关闭会被当成断线,再触发一轮选路。
    close: () => { f.closed = true; f.set({ status: 'closed' }) },
  }
}

const host = { url: 'ws://192.168.1.5:6789', relay: 'wss://relay.example', pubKey: 'PUBKEY', token: 't' }

function make(over: Partial<Parameters<typeof connectRouted>[0]> = {}) {
  const states: HostState[] = []
  const events: string[] = []
  const memory = freshMemory()
  const c = connectRouted({
    host, memory, clientVersion: '1.2.4',
    onEvent: (ch) => events.push(ch),
    onState: (s) => states.push(s),
    connect: fakeConnect,
    ...over,
  })
  return { c, states, events, memory }
}

beforeEach(() => { dials = []; vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('connectRouted —— 建连:先局域网,不通再中转', () => {
  it('★局域网通了:就用局域网,不去碰中转', () => {
    const { c } = make()
    expect(dials.map((d) => d.route)).toEqual(['lan'])
    dials[0].set(READY)
    expect(c.state().status).toBe('ready')
    expect(c.route()).toBe('lan')
    expect(dials).toHaveLength(1)
  })

  it('★局域网被拒(不在家):马上改走中转', () => {
    const { c } = make()
    dials[0].set({ status: 'closed' })
    expect(dials[0].closed).toBe(true)
    expect(dials.map((d) => d.route)).toEqual(['lan', 'relay'])
    dials[1].set(READY)
    expect(c.route()).toBe('relay')
  })

  it('★局域网挂着不回话(外网连 192.168.x.x 的常态):1.5 秒后放弃,改走中转', () => {
    make()
    vi.advanceTimersByTime(LAN_CONNECT_BUDGET_MS - 1)
    expect(dials).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(dials[0].closed).toBe(true)
    expect(dials[1].route).toBe('relay')
  })

  it('局域网那次拨号不自动重连(backoff:false)—— 它失败了该由这一层换路,而不是在原地退避', () => {
    make()
    expect(dials[0].opts.backoff).toBe(false)
    expect(dials[0].opts.relayUrl).toBeUndefined()
    expect(dials[0].opts.pubKey).toBe('PUBKEY') // 局域网那条照样端到端加密
  })

  it('尝试局域网期间对外只说「连接中」,不把局域网的失败漏出去', () => {
    const { states } = make()
    dials[0].set({ status: 'closed' })
    expect(states.some((s) => s.status === 'closed')).toBe(false)
  })

  it('★只有中转一条路(分享时没开局域网,码里是回环地址):直接拨中转,不白等', () => {
    make({ host: { ...host, url: 'ws://127.0.0.1:6789' } })
    expect(dials.map((d) => d.route)).toEqual(['relay'])
  })

  it('只有局域网一条路(没开中转):和原来一模一样,带自动重连', () => {
    make({ host: { ...host, relay: '' } })
    expect(dials.map((d) => d.route)).toEqual(['lan'])
    expect(dials[0].opts.backoff).not.toBe(false)
  })

  it('冷却期内建连直接走中转', () => {
    const memory = { ...freshMemory(), cooldownUntil: Date.now() + 60_000 }
    make({ memory })
    expect(dials.map((d) => d.route)).toEqual(['relay'])
  })
})

describe('connectRouted —— 走中转时探测局域网并迁移', () => {
  function onRelay() {
    const r = make()
    dials[0].set({ status: 'closed' })
    dials[1].set(READY)
    return r
  }

  it('★探到局域网通了:迁过去、关掉中转,对外经过一次「连接中」让各屏重新拉一遍数据', () => {
    const { c, states } = onRelay()
    states.length = 0
    c.probeLan({ foreground: true, force: true })
    expect(dials[2].route).toBe('lan')
    dials[2].set(READY)
    expect(dials[1].closed).toBe(true)
    expect(c.route()).toBe('lan')
    expect(states[0].status).toBe('connecting')
    vi.advanceTimersByTime(0)
    expect(c.state().status).toBe('ready')
  })

  it('探测没通:中转照用,探测那条关掉', () => {
    const { c } = onRelay()
    c.probeLan({ foreground: true, force: true })
    dials[2].set({ status: 'closed' })
    expect(dials[2].closed).toBe(true)
    expect(dials[1].closed).toBe(false)
    expect(c.route()).toBe('relay')
  })

  it('探测挂着不回话:3 秒后放弃', () => {
    const { c } = onRelay()
    c.probeLan({ foreground: true, force: true })
    vi.advanceTimersByTime(LAN_PROBE_BUDGET_MS)
    expect(dials[2].closed).toBe(true)
    expect(c.route()).toBe('relay')
  })

  it('★在后台不探', () => {
    const { c } = onRelay()
    c.probeLan({ foreground: false, force: true })
    expect(dials).toHaveLength(2)
  })

  it('★已经在局域网上不探', () => {
    const { c } = make()
    dials[0].set(READY)
    c.probeLan({ foreground: true, force: true })
    expect(dials).toHaveLength(1)
  })

  it('探测期间不重复起第二个探测', () => {
    const { c } = onRelay()
    c.probeLan({ foreground: true, force: true })
    c.probeLan({ foreground: true, force: true })
    expect(dials).toHaveLength(3)
  })

  it('★事件只从当前在用的那条转发 —— 探测连接收到的不能重复交给界面', () => {
    const { c, events } = onRelay()
    c.probeLan({ foreground: true, force: true })
    dials[2].event('from-probe', 1)
    dials[1].event('from-relay', 1)
    expect(events).toEqual(['from-relay'])
    dials[2].set(READY)
    dials[1].event('late-relay', 1)
    dials[2].event('from-lan', 1)
    expect(events).toEqual(['from-relay', 'from-lan'])
  })
})

describe('connectRouted —— 局域网断了', () => {
  it('★用了很久的局域网断了(出门了):重新选路,局域网不通就走中转', () => {
    const { c } = make()
    dials[0].set(READY)
    vi.advanceTimersByTime(10 * 60_000)
    dials[0].set({ status: 'closed' })
    expect(dials[1].route).toBe('lan')     // 先再试一次局域网(也许只是闪了一下)
    dials[1].set({ status: 'closed' })
    expect(dials[2].route).toBe('relay')
    dials[2].set(READY)
    expect(c.route()).toBe('relay')
  })

  it('★刚迁过去没多久就断(信号边缘):冷却 5 分钟,直接走中转,期间不再探', () => {
    const { c, memory } = make()
    dials[0].set(READY)
    vi.advanceTimersByTime(5_000)
    dials[0].set({ status: 'closed' })
    expect(dials[1].route).toBe('relay')
    expect(memory.cooldownUntil).toBeGreaterThan(Date.now())
    dials[1].set(READY)
    c.probeLan({ foreground: true, force: true })
    expect(dials).toHaveLength(2)
    vi.advanceTimersByTime(LAN_COOLDOWN_MS)
    c.probeLan({ foreground: true, force: true })
    expect(dials[2].route).toBe('lan')
  })
})

describe('connectRouted —— invoke / close', () => {
  it('★局域网失败换中转期间发出的调用,落到中转上而不是跟着局域网一起失败', async () => {
    const { c } = make()
    const p = c.invoke('chat:history')
    dials[0].set({ status: 'closed' })
    dials[1].set(READY)
    await expect(p).resolves.toBe('relay:chat:history')
  })

  it('close 把在用的、正在探的、计时器全收掉', () => {
    const { c } = make()
    dials[0].set({ status: 'closed' })
    dials[1].set(READY)
    c.probeLan({ foreground: true, force: true })
    c.close()
    expect(dials.every((d) => d.closed)).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(dials).toHaveLength(3)
  })

  it('鉴权/版本这类「重试也没用」的失败照实报出去', () => {
    const { c } = make({ host: { ...host, relay: '' } })
    dials[0].set({ status: 'failed', error: 'token 不对' })
    expect(c.state()).toEqual({ status: 'failed', error: 'token 不对' })
  })
})
