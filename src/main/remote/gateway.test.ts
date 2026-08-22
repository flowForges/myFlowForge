import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { startGateway } from './gateway'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { decodeFrame, encodeFrame, type Frame } from '@shared/remote/protocol'
import type { MethodTable } from '../ipc/invokeCtx'

// 真起服务、真连 socket。假 transport 测不出「少回一条 res 就永远挂着」这类东西。
type Client = {
  ws: WebSocket
  frames: Frame[]
  next(pred: (f: Frame) => boolean, ms?: number): Promise<Frame>
  send(f: unknown): void
  closed: Promise<{ code: number }>
}

const open: Client[] = []
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of open.splice(0)) { try { c.ws.close() } catch { /* 已关 */ } }
  for (const c of cleanup.splice(0)) await c()
})

function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Frame[] = []
  const waiters: { pred: (f: Frame) => boolean; res: (f: Frame) => void }[] = []
  let closeInfo: { code: number } | null = null
  const closeWaiters: ((v: { code: number }) => void)[] = []
  ws.on('message', (raw) => {
    const d = decodeFrame(String(raw))
    if (!d.ok) return
    frames.push(d.frame)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(d.frame)) { waiters.splice(i, 1)[0]!.res(d.frame) }
    }
  })
  ws.on('close', (code) => { closeInfo = { code }; closeWaiters.splice(0).forEach((r) => r({ code })) })
  const client: Client = {
    ws, frames,
    next: (pred, ms = 2000) => new Promise<Frame>((res, rej) => {
      const hit = frames.find(pred)
      if (hit) return res(hit)
      const t = setTimeout(() => rej(new Error('等帧超时')), ms)
      waiters.push({ pred, res: (f) => { clearTimeout(t); res(f) } })
    }),
    send: (f) => ws.send(encodeFrame(f as never)),
    closed: new Promise((res) => { if (closeInfo) res(closeInfo); else closeWaiters.push(res) }),
  }
  open.push(client)
  return new Promise((res, rej) => { ws.once('open', () => res(client)); ws.once('error', rej) })
}

async function boot(table: MethodTable, token?: string, authTimeoutMs?: number) {
  const hub = createBroadcastHub()
  const gw = await startGateway({ table, addSink: hub.addSink, version: '9.9.9', port: 0, token, authTimeoutMs })
  cleanup.push(() => gw.close())
  return { gw, hub }
}

describe('WS 网关', () => {
  it('连上就发 hello,不需要鉴权时紧接着 ready 带方法清单', async () => {
    const { gw } = await boot({ 'a:b': () => 1 })
    const c = await connect(gw.port)
    const hello = await c.next((f) => f.t === 'hello')
    expect(hello).toMatchObject({ t: 'hello', protocol: 1, version: '9.9.9', authRequired: false })
    expect(await c.next((f) => f.t === 'ready')).toMatchObject({ t: 'ready', methods: ['a:b'] })
  })

  it('req 把参数原样带到 handler,结果原样带回来', async () => {
    const seen: unknown[] = []
    const { gw } = await boot({ 'chat:send': (_ctx, ...args) => { seen.push(args); return { ok: true, n: 42 } } })
    const c = await connect(gw.port)
    await c.next((f) => f.t === 'ready')
    c.send({ t: 'req', id: 1, ch: 'chat:send', args: [{ text: '你好' }, null] })
    const res = await c.next((f) => f.t === 'res')
    expect(res).toEqual({ t: 'res', id: 1, ok: true, value: { ok: true, n: 42 } })
    expect(seen).toEqual([[{ text: '你好' }, null]])
  })

  it('handler 抛异常 → 回一条 res(ok:false),而不是静默丢', async () => {
    // ★少回一条 res,对面那个 promise 就永远不 settle —— 界面上是「点了一直转圈」。
    const { gw } = await boot({
      'sync:boom': () => { throw new Error('同步炸了') },
      'async:boom': async () => { throw new Error('异步炸了') },
    })
    const c = await connect(gw.port)
    await c.next((f) => f.t === 'ready')
    c.send({ t: 'req', id: 1, ch: 'sync:boom', args: [] })
    c.send({ t: 'req', id: 2, ch: 'async:boom', args: [] })
    expect(await c.next((f) => f.t === 'res' && f.id === 1)).toMatchObject({ ok: false, error: '同步炸了' })
    expect(await c.next((f) => f.t === 'res' && f.id === 2)).toMatchObject({ ok: false, error: '异步炸了' })
  })

  it('调一个这台机器没有的方法 → 回错误(版本不一致时会走到这儿)', async () => {
    const { gw } = await boot({ 'a:b': () => 1 })
    const c = await connect(gw.port)
    await c.next((f) => f.t === 'ready')
    c.send({ t: 'req', id: 5, ch: 'brand:new', args: [] })
    expect(await c.next((f) => f.t === 'res')).toMatchObject({ id: 5, ok: false })
  })

  it('broadcast 发给每一条连接', async () => {
    const { gw, hub } = await boot({ 'a:b': () => 1 })
    const c1 = await connect(gw.port); const c2 = await connect(gw.port)
    await Promise.all([c1.next((f) => f.t === 'ready'), c2.next((f) => f.t === 'ready')])
    hub.broadcast('chat:event', { type: 'delta' })
    for (const c of [c1, c2]) {
      expect(await c.next((f) => f.t === 'evt')).toEqual({ t: 'evt', ch: 'chat:event', payload: { type: 'delta' } })
    }
  })

  it('ctx.emit 只回发起调用的那条连接 —— 别人不该看到你的下载进度', async () => {
    // ★这正是 fontsDownload / nsfwGallery 的语义。串台的话:另一个窗口(以后是另一部手机)
    // 会跟着你的进度条一起动。
    const { gw } = await boot({
      'fonts:download': (ctx) => { ctx.emit('fonts:progress', { done: 3 }); return true },
      'noop:ping': () => 'pong',
    })
    const c1 = await connect(gw.port); const c2 = await connect(gw.port)
    await Promise.all([c1.next((f) => f.t === 'ready'), c2.next((f) => f.t === 'ready')])
    c1.send({ t: 'req', id: 1, ch: 'fonts:download', args: [] })
    expect(await c1.next((f) => f.t === 'evt')).toMatchObject({ ch: 'fonts:progress' })
    await c1.next((f) => f.t === 'res')

    // ★不能在这儿直接断言「c2 没收到」—— c2 那条 socket 的投递是另一条异步路径,事件可能
    // 晚一拍才到,断言会在它到达之前跑完,于是**变异测试证明过这条会假绿**。
    // 改成在 c2 上做一次往返:WS 保证同一条 socket 内有序,所以只要 c2 自己的 res 到了,
    // 任何更早发给它的 evt 就必然已经在 frames 里了。不是 sleep,是定序。
    c2.send({ t: 'req', id: 2, ch: 'noop:ping', args: [] })
    await c2.next((f) => f.t === 'res' && f.id === 2)
    expect(c2.frames.some((f) => f.t === 'evt')).toBe(false)
  })

  it('一条坏帧不会让后面的正常请求受影响', async () => {
    const { gw } = await boot({ 'a:b': () => 'ok' })
    const c = await connect(gw.port)
    await c.next((f) => f.t === 'ready')
    c.ws.send('这不是 json')
    c.ws.send('{"t":"exec","cmd":"rm -rf /"}')
    c.send({ t: 'req', id: 1, ch: 'a:b', args: [] })
    expect(await c.next((f) => f.t === 'res')).toMatchObject({ ok: true, value: 'ok' })
  })

  it('连接断开后 sink 被摘掉,广播不会再往死 socket 上写', async () => {
    const { gw, hub } = await boot({ 'a:b': () => 1 })
    const c = await connect(gw.port)
    await c.next((f) => f.t === 'ready')
    expect(hub.sinkCount()).toBe(1)
    c.ws.close()
    await c.closed
    await new Promise((r) => setTimeout(r, 50))
    expect(hub.sinkCount()).toBe(0)
    expect(gw.clientCount()).toBe(0)
  })

  describe('要 token 的时候', () => {
    it('token 对 → ready;hello 里先说明要鉴权', async () => {
      const { gw } = await boot({ 'a:b': () => 1 }, 's3cret')
      const c = await connect(gw.port)
      expect(await c.next((f) => f.t === 'hello')).toMatchObject({ authRequired: true })
      expect(c.frames.some((f) => f.t === 'ready')).toBe(false)   // ★鉴权前不给方法清单
      c.send({ t: 'auth', token: 's3cret' })
      expect(await c.next((f) => f.t === 'ready')).toMatchObject({ t: 'ready' })
    })

    it('token 不对 → 直接断开', async () => {
      const { gw } = await boot({ 'a:b': () => 1 }, 's3cret')
      const c = await connect(gw.port)
      await c.next((f) => f.t === 'hello')
      c.send({ t: 'auth', token: 'wrong' })
      expect((await c.closed).code).toBe(4403)
    })

    it('鉴权前直接发命令 → 断开,而且那条命令绝不执行', async () => {
      let called = false
      const { gw } = await boot({ 'danger:run': () => { called = true; return 1 } }, 's3cret')
      const c = await connect(gw.port)
      await c.next((f) => f.t === 'hello')
      c.send({ t: 'req', id: 1, ch: 'danger:run', args: [] })
      expect((await c.closed).code).toBe(4401)
      expect(called).toBe(false)
    })

    it('鉴权前不挂 sink —— 没通过的连接一个事件都收不到', async () => {
      const { gw, hub } = await boot({ 'a:b': () => 1 }, 's3cret')
      const c = await connect(gw.port)
      await c.next((f) => f.t === 'hello')
      expect(hub.sinkCount()).toBe(0)
      hub.broadcast('chat:event', { secret: true })
      await new Promise((r) => setTimeout(r, 30))
      expect(c.frames.some((f) => f.t === 'evt')).toBe(false)
    })

    it('迟迟不鉴权 → 超时踢掉,不许白占着连接', async () => {
      const { gw } = await boot({ 'a:b': () => 1 }, 's3cret', 60)
      const c = await connect(gw.port)
      await c.next((f) => f.t === 'hello')
      expect((await c.closed).code).toBe(4401)
    })

    it('token 长度不同也不匹配(别让长度本身变成旁路)', async () => {
      const { gw } = await boot({ 'a:b': () => 1 }, 's3cret')
      const c = await connect(gw.port)
      await c.next((f) => f.t === 'hello')
      c.send({ t: 'auth', token: 's3cretXXXX' })
      expect((await c.closed).code).toBe(4403)
    })
  })
})
