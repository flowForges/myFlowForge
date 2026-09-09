import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { clientHandshakeInit, generateIdentity } from '@shared/remote/e2e'
import { joinFrame, roomFor } from '@shared/remote/relayWire'
import { startRelay, type RelayHandle } from '../../../relay/src/node'
import { PING, PONG } from '@shared/remote/relayWire'
import { startRelayHost, type RelayHostHandle } from './relayHost'
import { clientE2ELink } from '@shared/remote/e2eChannel'
import type { Channel } from '@shared/remote/channel'
import type { MethodTable } from '../ipc/invokeCtx'

/**
 * **真中转 + 真加密 + 真方法表**,一条命令从"手机"出发到达 daemon 并把结果带回来。
 *
 * 这一组存在的理由:三层各自都单测过,不等于串起来能用。而串起来的失败方式恰恰是
 * 最难查的那种 —— 每一层都"没报错",只是没人往下走一步。
 */

let relay: RelayHandle | null = null
let host: RelayHostHandle | null = null
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* 已关 */ } }
  await host?.close()
  host = null
  await relay?.close()
  relay = null
})

const waitFor = async (pred: () => boolean, ms = 4000) => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('等条件超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * 一台"手机":连中转 → 进房间 → 端到端握手 → 说既有协议。
 * ★它拿的是**配对时那把公钥**(`trustedPub`),不是对面自报的任何东西。
 */
async function phone(port: number, room: string, trustedPub: Uint8Array, token?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  sockets.push(ws)
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
  ws.send(JSON.stringify(joinFrame('client', room)))

  /** 中转看到的每一个字节(用来证明它读不懂)。 */
  const wireSeen: string[] = []
  const frames: any[] = []
  let ch: Channel | null = null
  let failure = ''

  const link = clientE2ELink(
    trustedPub,
    {
      sendRaw: (t) => { wireSeen.push(t); ws.send(t) },
      closeRaw: () => { try { ws.close() } catch { /* 已关 */ } },
    },
    (c) => {
      ch = c
      c.onMessage((t) => {
        const f = JSON.parse(t)
        frames.push(f)
        // 既有协议:hello 里说要鉴权就把 token 递上去
        if (f.t === 'hello' && f.authRequired && token) c.send(JSON.stringify({ t: 'auth', token }))
      })
    },
    (why) => { failure = why },
  )

  ws.on('message', (raw: unknown) => {
    const text = String(raw)
    // 中转自己的状态帧跳过 —— 它不属于两端的对话
    try { if (JSON.parse(text)?.t === 'relay') return } catch { /* 密文不是 JSON,继续 */ }
    wireSeen.push(text)
    link.receive(text)
  })

  let nextId = 1
  return {
    ws,
    frames,
    wireSeen,
    failure: () => failure,
    ready: () => frames.some((f) => f.t === 'ready'),
    /** 发一次调用,等它的响应。 */
    async invoke(chn: string, args: unknown[] = []) {
      const id = nextId++
      ch!.send(JSON.stringify({ t: 'req', id, ch: chn, args }))
      await waitFor(() => frames.some((f) => f.t === 'res' && f.id === id))
      return frames.find((f) => f.t === 'res' && f.id === id)
    },
  }
}

/** 一张最小方法表 + 一条能主动推事件的广播总线。 */
function fakeCore() {
  const sinks = new Set<(ch: string, p: unknown) => void>()
  const calls: { ch: string; args: unknown[]; label: string }[] = []
  const table: MethodTable = {
    'echo:say': async (ctx, ...args) => {
      calls.push({ ch: 'echo:say', args, label: ctx.client?.label ?? '' })
      return { said: args[0] }
    },
    'echo:boom': async () => { throw new Error('炸了') },
  }
  return {
    table,
    calls,
    addSink: (s: (ch: string, p: unknown) => void) => { sinks.add(s); return () => sinks.delete(s) },
    broadcast: (ch: string, p: unknown) => { for (const s of sinks) s(ch, p) },
    sinkCount: () => sinks.size,
  }
}

describe('通过不可信中转对外服务方法表', () => {
  it('★★一次远程调用从头到尾走通,而中转全程只见到密文', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
    })
    await waitFor(() => host!.status().status === 'online')

    const p = await phone(relay.port, roomFor(identity.publicKey), identity.publicKey)
    await waitFor(() => p.ready())

    const res = await p.invoke('echo:say', ['你好'])
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ said: '你好' })
    expect(core.calls).toHaveLength(1)

    // ★★中转搬过的每一串里都不能出现方法名或参数
    const all = p.wireSeen.join('\n')
    expect(all).not.toContain('echo:say')
    expect(all).not.toContain('你好')
  })

  it('房间号就是公钥算出来的 —— 两端各自算,不需要在中转注册', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
    })
    expect(host.room).toBe(roomFor(identity.publicKey))
  })

  it('★handler 抛错要变成一条 res,不能让对面永远挂着', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
    })
    await waitFor(() => host!.status().status === 'online')
    const p = await phone(relay.port, roomFor(identity.publicKey), identity.publicKey)
    await waitFor(() => p.ready())
    const res = await p.invoke('echo:boom')
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('炸了')
  })

  it('★★两台设备同时连着,各自的调用不串 —— cid 那层的端到端证明', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
    })
    await waitFor(() => host!.status().status === 'online')

    const room = roomFor(identity.publicKey)
    const a = await phone(relay.port, room, identity.publicKey)
    const b = await phone(relay.port, room, identity.publicKey)
    await waitFor(() => a.ready() && b.ready())

    const [ra, rb] = await Promise.all([a.invoke('echo:say', ['来自 A']), b.invoke('echo:say', ['来自 B'])])
    expect(ra.value).toEqual({ said: '来自 A' })
    expect(rb.value).toEqual({ said: '来自 B' })
    // ★而且 A 的线上不该出现 B 的东西(它们各自一把密钥,连密文都不该到对方那儿)
    expect(a.wireSeen.join('\n')).not.toContain('来自 B')
  })

  it('★广播事件推给每一台连着的设备', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
    })
    await waitFor(() => host!.status().status === 'online')
    const room = roomFor(identity.publicKey)
    const a = await phone(relay.port, room, identity.publicKey)
    const b = await phone(relay.port, room, identity.publicKey)
    await waitFor(() => a.ready() && b.ready())

    core.broadcast('chat:event', { type: 'done' })
    await waitFor(() => a.frames.some((f) => f.t === 'evt') && b.frames.some((f) => f.t === 'evt'))
    expect(a.frames.find((f) => f.t === 'evt')).toEqual({ t: 'evt', ch: 'chat:event', payload: { type: 'done' } })
  })

  it('★★设备走了要把它那路广播 sink 摘掉 —— 不摘的话 daemon 会一直往一条死连接上推', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
    })
    await waitFor(() => host!.status().status === 'online')
    const p = await phone(relay.port, roomFor(identity.publicKey), identity.publicKey)
    await waitFor(() => p.ready())
    expect(core.sinkCount()).toBe(1)

    p.ws.close()
    await waitFor(() => core.sinkCount() === 0)
  })

  it('★中转这条路上仍然要令牌:加密回答「谁能听」,令牌回答「谁能用」', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0', token: '正确的令牌',
    })
    await waitFor(() => host!.status().status === 'online')
    const room = roomFor(identity.publicKey)

    // 带对令牌的 → 能 ready
    const ok = await phone(relay.port, room, identity.publicKey, '正确的令牌')
    await waitFor(() => ok.ready())

    // 带错令牌的 → 被断开,而且**永远拿不到 ready**
    const bad = await phone(relay.port, room, identity.publicKey, '错的')
    await waitFor(() => bad.frames.some((f) => f.t === 'hello'))
    await new Promise((r) => setTimeout(r, 300))
    expect(bad.ready()).toBe(false)
  })

  it('★★冒充者:握手就过不去,一条命令都发不出', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
    })
    await waitFor(() => host!.status().status === 'online')

    // 他知道房间号(它是从**公开的**公钥算出来的),但他信的是自己那把假公钥
    const impostorTrust = generateIdentity().publicKey
    const p = await phone(relay.port, roomFor(identity.publicKey), impostorTrust)
    await waitFor(() => p.failure() !== '')
    expect(p.failure()).toContain('证明不了自己')
    expect(core.calls).toHaveLength(0)
  })

  it('中转掉线后会退避重连(daemon 是常驻的,不该掉线一整晚)', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    const port = relay.port
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
      backoff: { baseMs: 50, maxMs: 100 },
    })
    await waitFor(() => host!.status().status === 'online')

    await relay.close()
    relay = null
    await waitFor(() => host!.status().status === 'retrying' || host!.status().status === 'connecting')

    // 中转回来了(同一个端口)
    relay = await startRelay({ port, host: '127.0.0.1', pingMs: 0 })
    await waitFor(() => host!.status().status === 'online', 8000)
  })

  it('★★中转断了要把所有逻辑连接一起作废 —— 否则重连后新 cid 撞上旧密钥,静默解不开', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    const port = relay.port
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
      backoff: { baseMs: 50, maxMs: 100 },
    })
    await waitFor(() => host!.status().status === 'online')
    const p = await phone(relay.port, roomFor(identity.publicKey), identity.publicKey)
    await waitFor(() => p.ready())
    expect(core.sinkCount()).toBe(1)

    await relay.close()
    relay = null
    // sink 必须被摘干净 —— 这就是"逻辑连接一起作废"的可观察证据
    await waitFor(() => core.sinkCount() === 0)

    relay = await startRelay({ port, host: '127.0.0.1', pingMs: 0 })
    await waitFor(() => host!.status().status === 'online', 8000)
    // 重连之后新设备照样连得上(旧表没有污染它)
    const q = await phone(relay.port, roomFor(identity.publicKey), identity.publicKey)
    await waitFor(() => q.ready())
    const res = await q.invoke('echo:say', ['重连之后'])
    expect(res.value).toEqual({ said: '重连之后' })
  })

  it('★房间被别人占了是「重试也没用」,不能拿退避刷一整晚', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    // 先有人占住这个房间
    const squatter = new WebSocket(`ws://127.0.0.1:${relay.port}`)
    sockets.push(squatter)
    await new Promise<void>((res, rej) => { squatter.once('open', () => res()); squatter.once('error', rej) })
    squatter.send(JSON.stringify(joinFrame('host', roomFor(identity.publicKey))))
    await new Promise((r) => setTimeout(r, 100))

    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
      backoff: { baseMs: 50, maxMs: 100 },
    })
    await waitFor(() => host!.status().status === 'failed')
    expect((host.status() as { error: string }).error).toContain('主机')
  })

  it('★★恶意中转不能凭空造一条逻辑连接 —— `open` 是唯一入口', async () => {
    // 变异测试抓到的洞:原来这条性质只写在注释里,没有任何断言钉住。
    // 一个被控制的中转如果能靠直接发 `data` 就让 daemon 跟它握手,那"中转是哑管道"
    // 这句话就不成立了 —— 它成了决定谁能跟 daemon 对话的那个人。
    const identity = generateIdentity()
    const core = fakeCore()

    // 一台**自己写的、会撒谎的**中转
    const evil = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((res) => evil.once('listening', () => res()))
    const evilPort = (evil.address() as { port: number }).port
    const fromHost: string[] = []
    evil.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const text = String(raw)
        if (text.includes('"join"')) {
          ws.send(JSON.stringify({ t: 'relay', status: 'waiting' }))
          // 从没发过 open,直接塞一条**合法的** hs-init 进来
          const { frame } = clientHandshakeInit()
          ws.send(JSON.stringify({ t: 'data', cid: '99', d: JSON.stringify(frame) }))
          return
        }
        fromHost.push(text)
      })
    })

    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${evilPort}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
      backoff: false,
    })
    await waitFor(() => host!.status().status === 'online')
    await new Promise((r) => setTimeout(r, 300))

    // daemon 一个字都不该回给这个凭空冒出来的 cid
    expect(fromHost.filter((t) => t.includes('"99"'))).toHaveLength(0)
    // 而且没有任何 sink 被挂上(没有 serveConnection 被创建)
    expect(core.sinkCount()).toBe(0)

    // ★收尾顺序有讲究:`wss.close(cb)` 要等所有连接都断了才回调。
    //  先把 daemon 那条关掉,再关这台假中转,否则这里会一直挂到测试超时。
    await host.close()
    host = null
    for (const c of evil.clients) { try { c.terminate() } catch { /* 无所谓 */ } }
    await new Promise<void>((res) => evil.close(() => res()))
  })

  it('close() 幂等,而且之后不再重连', async () => {
    const identity = generateIdentity()
    const core = fakeCore()
    relay = await startRelay({ port: 0, host: '127.0.0.1', pingMs: 0 })
    host = startRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      identity, table: core.table, addSink: core.addSink, version: '1.2.0',
      backoff: { baseMs: 20, maxMs: 40 },
    })
    await waitFor(() => host!.status().status === 'online')
    await host.close()
    await host.close()
    await new Promise((r) => setTimeout(r, 200))
    expect(host.status().status).toBe('off')
  })
})

/**
 * ★★链路心跳。防的是**这条 socket 死了但没人知道** —— 合盖 / 切网 / 拔网线造出来的僵尸
 * 不会触发 close 事件,而同一个房间只准一个 host ⇒ 真主机回来时看到的是
 * 「这个房间已经有一台主机连着了」,而那台就是它自己(2026-09-09 用户真踩到)。
 *
 * ★这一组用**假中转**而不是真的:要能精确控制「回不回 pong」,真中转永远回。
 */
describe('链路心跳', () => {
  /**
   * 一台假中转。`pong` 决定它认不认心跳 —— 这正是新版和**老版**中转的唯一区别。
   * 记下每一次连接,好数出「重连了没有」。
   */
  async function fakeRelay(opts: { pong: boolean }) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const conns: WebSocket[] = []
    let pings = 0
    wss.on('connection', (ws: WebSocket) => {
      conns.push(ws)
      ws.on('message', (raw: unknown) => {
        const text = String(raw)
        if (text === PING) { pings++; if (opts.pong) ws.send(PONG); return }
        // join 帧:照真中转回一个 waiting,好让 host 进入 online
        try { if (JSON.parse(text).t === 'join') ws.send(JSON.stringify({ t: 'relay', status: 'waiting' })) }
        catch { /* 不是 JSON,无视 */ }
      })
    })
    const port = (wss.address() as { port: number }).port
    return {
      port,
      get conns() { return conns },
      get pings() { return pings },
      /** 从现在起不再回 pong —— 模拟「socket 还在,对面已经死了」。 */
      goSilent() { opts.pong = false },
      close: () => new Promise<void>((r) => { for (const c of conns) { try { c.terminate() } catch { /* 已关 */ } } wss.close(() => r()) }),
    }
  }
  let fake: Awaited<ReturnType<typeof fakeRelay>> | null = null
  afterEach(async () => { await fake?.close(); fake = null })

  const startHost = (port: number) => startRelayHost({
    relayUrl: `ws://127.0.0.1:${port}`,
    identity: generateIdentity(),
    table: {} as MethodTable,
    addSink: () => () => {},
    version: '1.2.0',
    pingMs: 25,
    backoff: { baseMs: 10, maxMs: 20 },
  })

  it('连上之后开始发心跳', async () => {
    fake = await fakeRelay({ pong: true })
    host = startHost(fake.port)
    await waitFor(() => fake!.pings >= 2)
    expect(host.status().status).toBe('online')
  })

  /**
   * ★这条是变异测试逼出来的:把「收到 pong 就把 missed 清零」删掉,上面两条**全绿** ——
   *  因为它们只看「有没有重连」的**下界**。而漏掉清零的后果是:一个**一直健康**的中转
   *  也会在几拍之后被判死,然后无限重连。这里钉的是上界。
   */
  it('★★一直回 pong 的中转,永远不许被重连', async () => {
    fake = await fakeRelay({ pong: true })
    host = startHost(fake.port)
    await waitFor(() => fake!.pings >= 6)   // 远超 MISS_LIMIT 的拍数
    expect(fake.conns.length, '健康的中转被判死了 —— 多半是收到 pong 没清零').toBe(1)
    expect(host.status().status).toBe('online')
  })

  it('★★回过 pong 之后开始不回了 —— 判定这条已经死了,重连', async () => {
    fake = await fakeRelay({ pong: true })
    host = startHost(fake.port)
    await waitFor(() => fake!.pings >= 2)          // 先确认这个中转是认心跳的
    expect(fake.conns.length).toBe(1)
    fake.goSilent()
    // 连丢 MISS_LIMIT 次之后应该主动断开并重连 ⇒ 假中转上会出现第二条连接
    await waitFor(() => fake!.conns.length >= 2, 5000)
  })

  it('★★★老中转(从来不回 pong)不许被判死 —— 否则连老中转会变成无限重连', async () => {
    fake = await fakeRelay({ pong: false })
    host = startHost(fake.port)
    await waitFor(() => fake!.pings >= 4)          // 发了四次,一次回音都没有
    await new Promise((r) => setTimeout(r, 120))   // 再给足够久
    expect(fake.conns.length, '它把老中转判死了 —— 这会变成无限重连').toBe(1)
    expect(host.status().status).toBe('online')
  })
})
