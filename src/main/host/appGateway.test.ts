import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { createAppGateway, type MobileStatus } from './appGateway'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { decodeFrame, encodeFrame, type Frame } from '@shared/remote/protocol'
import type { MethodTable } from '../ipc/invokeCtx'

/**
 * 真起网关、真连 socket。
 *
 * 这里要钉住的核心性质是 **「只有一份核心」**:手机那一刀落在的,必须是本机窗口用的同一张
 * 方法表、同一条广播总线。在此之前只能另起 `daemon.js`,那是第二个独立核心 ——
 * 手机答掉的门电脑上不会消失,这条性质没有测试就守不住。
 */

const socks: WebSocket[] = []
const gws: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const s of socks.splice(0)) { try { s.close() } catch { /* 已关 */ } }
  for (const g of gws.splice(0)) await g.close()
})

type Client = { send(f: unknown): void; next(pred: (f: Frame) => boolean, ms?: number): Promise<Frame> }

function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  socks.push(ws)
  const frames: Frame[] = []
  const waiters: { pred: (f: Frame) => boolean; res: (f: Frame) => void }[] = []
  ws.on('message', (raw) => {
    const d = decodeFrame(String(raw))
    if (!d.ok) return
    frames.push(d.frame)
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(d.frame)) waiters.splice(i, 1)[0]!.res(d.frame)
  })
  const c: Client = {
    send: (f) => ws.send(encodeFrame(f as never)),
    next: (pred, ms = 3000) => new Promise((res, rej) => {
      const hit = frames.find(pred)
      if (hit) return res(hit)
      const t = setTimeout(() => rej(new Error('等帧超时')), ms)
      waiters.push({ pred, res: (f) => { clearTimeout(t); res(f) } })
    }),
  }
  return new Promise((res, rej) => { ws.once('open', () => res(c)); ws.once('error', rej) })
}

function make(table: MethodTable) {
  const hub = createBroadcastHub()
  const seen: MobileStatus[] = []
  const gw = createAppGateway({
    table, addSink: hub.addSink, version: '9.9.9', onStatus: (s) => seen.push(s),
  })
  gws.push(gw)
  return { gw, hub, seen }
}

// port 0 = 让内核挑一个空闲端口。写死端口的测试在并发跑时会互相撞。
const LOOPBACK = (port = 0) => ({ enabled: true, host: '127.0.0.1', port })

describe('app 自己端的手机端网关', () => {
  it('关着的时候什么都不听', async () => {
    const { gw } = make({ 'a:b': () => 1 })
    const st = await gw.apply({ enabled: false, host: '127.0.0.1', port: 0 })
    expect(st.running).toBe(false)
  })

  // ★这条就是这次改动的全部意义:手机那一刀落在**本机窗口用的同一张表**上。
  //  另起 daemon 时它是另一份闭包,两边各记各的账 —— 门、会话状态全对不上。
  it('手机那一刀落在同一份核心上,不是另一份拷贝', async () => {
    let calls = 0
    const table: MethodTable = { 'chat:send': () => { calls += 1 } }
    const { gw } = make(table)
    const st = await gw.apply(LOOPBACK())

    // 本机窗口那一路:直接调表
    table['chat:send']!({ emit: () => {} })
    expect(calls).toBe(1)

    // 手机那一路:走 socket
    const c = await connect(st.port)
    await c.next((f) => f.t === 'ready')
    c.send({ t: 'req', id: 1, ch: 'chat:send', args: [] })
    await c.next((f) => f.t === 'res')
    expect(calls).toBe(2)   // 同一个计数器 —— 同一份核心
  })

  it('本机核心广播出去的事件,手机当场收得到', async () => {
    const { gw, hub } = make({ 'a:b': () => 1 })
    const st = await gw.apply(LOOPBACK())
    const c = await connect(st.port)
    await c.next((f) => f.t === 'ready')
    hub.broadcast('chat:event', { type: 'confirm-request', id: 'cc-1' })
    const evt = await c.next((f) => f.t === 'evt')
    expect(evt).toMatchObject({ t: 'evt', ch: 'chat:event' })
  })

  it('只对外提供 daemon 那张表 —— 弹系统对话框那两个不给', async () => {
    const { gw } = make({ 'a:b': () => 1, 'dialog:pick-directory': () => '/x', 'shell:open-external': () => 1 })
    const st = await gw.apply(LOOPBACK())
    const c = await connect(st.port)
    const ready = await c.next((f) => f.t === 'ready')
    const methods = (ready as { methods: string[] }).methods
    expect(methods).toContain('a:b')
    // 手机那头看不见这台机器的屏幕,弹出来的窗它永远答不了。
    expect(methods).not.toContain('dialog:pick-directory')
    // CLIENT_ONLY 的也不给:「用默认程序打开」该发生在有人看着屏幕的那台设备上。
    expect(methods).not.toContain('shell:open-external')
  })

  it('关掉之后端口是真的不听了', async () => {
    const { gw } = make({ 'a:b': () => 1 })
    const st = await gw.apply(LOOPBACK())
    const port = st.port
    await gw.apply({ enabled: false, host: '127.0.0.1', port })
    await expect(connect(port)).rejects.toBeTruthy()
  })

  it('换端口 = 旧的关掉、新的起来', async () => {
    const { gw } = make({ 'a:b': () => 1 })
    const first = await gw.apply(LOOPBACK())
    // 借第二个网关占一个空闲端口再放掉,拿到一个**确定可用且和 first 不同**的端口号。
    // 直接写 first.port + 1 是会偶发撞车的那种测试。
    const probe = make({ 'a:b': () => 1 })
    const free = (await probe.gw.apply(LOOPBACK())).port
    await probe.gw.close()

    const second = await gw.apply(LOOPBACK(free))
    expect(second.running).toBe(true)
    expect(second.port).toBe(free)
    await expect(connect(first.port)).rejects.toBeTruthy()
  })

  // ★配置没变就不重启。设置面板里改任何别的东西都会走一次 apply —— 每次都重启的话,
  //  连着的手机会被无缘无故踢下线,而且正在等的那些调用全部作废。
  it('配置没变就不动它,已连着的设备不掉线', async () => {
    const { gw } = make({ 'a:b': () => 1 })
    const st = await gw.apply(LOOPBACK())
    const c = await connect(st.port)
    await c.next((f) => f.t === 'ready')
    const again = await gw.apply({ enabled: true, host: '127.0.0.1', port: st.port })
    expect(again.port).toBe(st.port)
    // 还是原来那条连接:重启过的话这一刀会打在一个已经关掉的 socket 上。
    c.send({ t: 'req', id: 9, ch: 'a:b', args: [] })
    expect(await c.next((f) => f.t === 'res')).toMatchObject({ t: 'res', id: 9, ok: true })
  })

  // ★起不来必须说出来。开关拨过去了、界面显示「已开启」、实际没有任何东西在听 ——
  //  那是最难查的一类,而端口被占是最常见的原因。
  it('端口被占时报错并如实说自己没在跑', async () => {
    const a = make({ 'a:b': () => 1 })
    const st = await a.gw.apply(LOOPBACK())
    const b = make({ 'a:b': () => 1 })
    const bad = await b.gw.apply({ enabled: true, host: '127.0.0.1', port: st.port })
    expect(bad.running).toBe(false)
    expect(bad.error).toBeTruthy()
  })

  it('状态变化会叫一声,渲染层不用轮询', async () => {
    const { gw, seen } = make({ 'a:b': () => 1 })
    await gw.apply(LOOPBACK())
    expect(seen.some((s) => s.running)).toBe(true)
    await gw.apply({ enabled: false, host: '127.0.0.1', port: 0 })
    expect(seen[seen.length - 1]!.running).toBe(false)
  })

  it('绑回环时不要令牌', async () => {
    const { gw } = make({ 'a:b': () => 1 })
    const st = await gw.apply(LOOPBACK())
    expect(st.token).toBe('')
  })
})
