import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHostRouter } from './router'
import { NOOP_CTX } from '../ipc/invokeCtx'
import type { RemoteHost } from './hostStore'
import type { ConnectOpts, RemoteClient, RemoteState } from './remoteClient'
import { LAN_CONNECT_BUDGET_MS, LAN_FLAP_WINDOW_MS } from '@shared/remote/routePick'

// 2026-10-07:桌面端连远程主机,配对码里局域网和中转都有时,先局域网、不通再中转;
// 局域网断了重新选路(出门了就落到中转)。第一期桌面不做「走中转时主动迁回局域网」——
// 笔记本合盖再打开本来就会重连,重连时自然先试局域网。
type Fake = { opts: ConnectOpts; route: 'lan' | 'relay'; set: (s: RemoteState) => void; closed: boolean }
let dials: Fake[]
const READY: RemoteState = { status: 'ready', version: '1.2.4', methods: new Set(['chat:send']) }

function fakeConnect(opts: ConnectOpts): RemoteClient {
  let st: RemoteState = { status: 'connecting', attempt: 1 }
  const ws = new Set<(s: RemoteState) => void>()
  const f: Fake = {
    opts, route: opts.relayUrl ? 'relay' : 'lan', closed: false,
    set: (s) => { st = s; opts.onState?.(s); for (const w of [...ws]) w(s) },
  }
  dials.push(f)
  return {
    state: () => st,
    onState: (cb) => { ws.add(cb); return () => ws.delete(cb) },
    invoke: async (ch) => `${f.route}:${ch}`,
    hops: () => ({ viaRelay: f.route === 'relay', relaySocketOpen: false, peerReady: st.status === 'ready' }),
    // 真的 remoteClient 关闭时也会报一次 closed —— router 必须分得清是自己关的。
    close: async () => { f.closed = true; f.set({ status: 'closed' }) },
  }
}

const host = (over: Partial<RemoteHost> = {}): RemoteHost => ({
  id: 'h1', label: '家里的 Mac', kind: 'direct', address: 'ws://192.168.1.5:6789', sshTarget: '',
  pubKey: 'PUBKEY', relay: 'wss://relay.example', icon: '', display: 'both', token: 't', lastConnectedAt: 0, ...over,
})

function setup() {
  return createHostRouter({
    localTable: { 'chat:send': () => '本机' }, toWindows: vi.fn(), clientVersion: '1.2.4',
    onStatus: () => {},
    resolveUrl: async (h) => ({ url: h.address }),
    connect: fakeConnect,
  })
}

beforeEach(() => { dials = []; vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('桌面端连远程主机:先局域网,不通再中转', () => {
  it('★局域网通了:用局域网,界面上不会挂「中转」', async () => {
    const r = setup()
    await r.connect(host())
    expect(dials.map((d) => d.route)).toEqual(['lan'])
    dials[0].set(READY)
    expect(r.status().state.status).toBe('ready')
    expect(r.status().hops?.viaRelay).toBe(false)
  })

  it('★局域网被拒:马上改走中转', async () => {
    const r = setup()
    await r.connect(host())
    dials[0].set({ status: 'closed' })
    expect(dials.map((d) => d.route)).toEqual(['lan', 'relay'])
    dials[1].set(READY)
    expect(r.status().hops?.viaRelay).toBe(true)
  })

  it('★局域网挂着不回话:1.5 秒后放弃,改走中转', async () => {
    const r = setup()
    await r.connect(host())
    vi.advanceTimersByTime(LAN_CONNECT_BUDGET_MS)
    expect(dials[0].closed).toBe(true)
    expect(dials[1].route).toBe('relay')
    expect(r.status().state.status).toBe('connecting')
  })

  it('局域网那次不自动重连,也不走代理(代理只给中转用)', async () => {
    const r = setup()
    await r.connect(host())
    expect(dials[0].opts.backoff).toBe(false)
    expect(dials[0].opts.relayUrl).toBeUndefined()
    expect(dials[0].opts.pubKey).toBe('PUBKEY')
  })

  it('尝试局域网期间对外不报 closed', async () => {
    const seen: string[] = []
    const r = createHostRouter({
      localTable: {}, toWindows: vi.fn(), clientVersion: '1.2.4', connect: fakeConnect,
      onStatus: (s) => seen.push(s.state.status), resolveUrl: async (h) => ({ url: h.address }),
    })
    await r.connect(host())
    dials[0].set({ status: 'closed' })
    expect(seen).not.toContain('closed')
  })

  it('★码里是回环地址(分享时没开局域网):直接中转', async () => {
    const r = setup()
    await r.connect(host({ address: 'ws://127.0.0.1:6789' }))
    expect(dials.map((d) => d.route)).toEqual(['relay'])
  })

  it('没开中转的老主机:和原来一样,单条路、自动重连', async () => {
    const r = setup()
    await r.connect(host({ relay: '' }))
    expect(dials.map((d) => d.route)).toEqual(['lan'])
    expect(dials[0].opts.backoff).toBeUndefined()
  })

  it('SSH 主机不参与选路', async () => {
    const r = setup()
    await r.connect(host({ kind: 'ssh' }))
    expect(dials.map((d) => d.route)).toEqual(['relay'])
  })
})

describe('局域网断了', () => {
  it('★用了很久才断(出门了):重新选路,局域网不通就落到中转', async () => {
    const r = setup()
    await r.connect(host())
    dials[0].set(READY)
    vi.advanceTimersByTime(10 * 60_000)
    dials[0].set({ status: 'closed' })
    expect(dials[1].route).toBe('lan')
    dials[1].set({ status: 'closed' })
    expect(dials[2].route).toBe('relay')
    dials[2].set(READY)
    expect(r.status().hops?.viaRelay).toBe(true)
  })

  it('★刚连上没多久就断(信号边缘):冷却,直接走中转,不白等', async () => {
    const r = setup()
    await r.connect(host())
    dials[0].set(READY)
    vi.advanceTimersByTime(LAN_FLAP_WINDOW_MS - 1000)
    dials[0].set({ status: 'closed' })
    expect(dials[1].route).toBe('relay')
    // 冷却跨过一次重连:用户手动重连同一台,也不该再白等 1.5 秒
    await r.connect(host())
    expect(dials[2].route).toBe('relay')
  })
})

describe('调用与断开', () => {
  it('★局域网失败换中转期间发出的调用,落到中转上', async () => {
    const r = setup()
    await r.connect(host())
    const p = r.invoke('chat:send', NOOP_CTX, [])
    dials[0].set({ status: 'closed' })
    dials[1].set(READY)
    await expect(p).resolves.toBe('relay:chat:send')
  })

  it('断开后计时器不再拨号', async () => {
    const r = setup()
    await r.connect(host())
    await r.disconnect()
    vi.advanceTimersByTime(60_000)
    expect(dials).toHaveLength(1)
    expect(dials[0].closed).toBe(true)
  })
})
