import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { startGateway } from './gateway'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { decodeFrame, encodeFrame, type Frame } from '@shared/remote/protocol'
import { generateIdentity } from '@shared/remote/e2e'
import { clientE2ELink } from '@shared/remote/e2eChannel'
import type { Channel } from '@shared/remote/channel'
import type { MethodTable } from '../ipc/invokeCtx'

/**
 * 局域网直连 + 端到端加密。**真起网关、真开 socket、真跑握手**。
 *
 * ★★这一整个文件是为一个**活着的 bug** 写的:配对码带公钥时客户端会发 `hs-init`,
 *  而网关以前一个字都不认(E2E 只在中转那条路上有)—— 它照旧回明文 `hello`,
 *  客户端当场判「握手回复形状不对」然后断开。手机走局域网直连是**连不上**的。
 *
 * ★所以这里两条路都必须钉死:带公钥的能握手,不带公钥的老客户端**一个都不能断**。
 */

const open: { close: () => void }[] = []
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of open.splice(0)) { try { c.close() } catch { /* 已关 */ } }
  for (const c of cleanup.splice(0)) await c()
})

type Extra = Partial<Parameters<typeof startGateway>[0]>

async function boot(table: MethodTable, extra: Extra = {}) {
  const hub = createBroadcastHub()
  const gw = await startGateway({
    table, addSink: hub.addSink, version: '9.9.9', port: 0,
    // ★★窗口默认给**大**的。它是「窗口内没等到 hs-init 就断定对面是明文」——
    //  全量并行跑时 CPU 饱和,hs-init 完全可能晚于一个 30ms 的窗口到达,于是加密用例
    //  随机报「对面这台电脑的版本太老」。**那是机器慢,不是代码错**,但它长得和真 bug
    //  一模一样。加密那条路窗口开多大都不影响速度(hs-init 一到就立刻决定,零延迟);
    //  只有真要等窗口过完的那两条才调小,各自在用例里写明。
    e2eGraceMs: 1500,
    ...extra,
  })
  cleanup.push(() => gw.close())
  return { gw, hub }
}

/** 一条**明文**的客户端连接:连上什么都不发,等对面先说 hello(和老版客户端逐字一样)。 */
function plainClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  return wrap(ws, (cb) => ws.on('message', (raw) => cb(String(raw))), (t) => ws.send(t), ws)
}

/** 一条**加密**的客户端连接:连上立刻发 hs-init,握完手后协议帧全部走密文。 */
function e2eClient(port: number, trustedPub: Uint8Array) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  let sealed: Channel | null = null
  const fails: string[] = []
  let onPlain: ((t: string) => void) | null = null
  ws.on('open', () => {
    const link = clientE2ELink(
      trustedPub,
      { sendRaw: (t) => { try { ws.send(t) } catch { /* 已断 */ } }, closeRaw: () => { try { ws.close() } catch { /* 已关 */ } } },
      (ch) => { sealed = ch; ch.onMessage((t) => onPlain?.(t)) },
      (why) => fails.push(why),
    )
    ws.on('message', (raw) => link.receive(String(raw)))
  })
  const c = wrap(ws, (cb) => { onPlain = cb }, (t) => {
    if (!sealed) throw new Error('还没握完手')
    sealed.send(t)
  }, ws)
  return Object.assign(c, { fails, handshook: () => sealed != null })
}

function wrap(
  ws: WebSocket,
  listen: (cb: (text: string) => void) => void,
  sendText: (text: string) => void,
  sock: WebSocket,
) {
  const frames: Frame[] = []
  const waiters: { pred: (f: Frame) => boolean; res: (f: Frame) => void }[] = []
  let closeInfo: { code: number } | null = null
  const closeWaiters: ((v: { code: number }) => void)[] = []
  listen((text) => {
    const d = decodeFrame(text)
    if (!d.ok) return
    frames.push(d.frame)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(d.frame)) waiters.splice(i, 1)[0]!.res(d.frame)
    }
  })
  sock.on('close', (code) => { closeInfo = { code }; closeWaiters.splice(0).forEach((r) => r({ code })) })
  sock.on('error', () => { /* close 会跟着来 */ })
  const client = {
    frames,
    next: (pred: (f: Frame) => boolean, ms = 3000) => new Promise<Frame>((res, rej) => {
      const hit = frames.find(pred)
      if (hit) return res(hit)
      const t = setTimeout(() => rej(new Error('等帧超时')), ms)
      waiters.push({ pred, res: (f) => { clearTimeout(t); res(f) } })
    }),
    sendRaw: (text: string) => sendText(text),
    send: (f: unknown) => sendText(encodeFrame(f as never)),
    close: () => { try { sock.close() } catch { /* 已关 */ } },
    closed: new Promise<{ code: number }>((res) => { if (closeInfo) res(closeInfo); else closeWaiters.push(res) }),
    opened: new Promise<void>((res, rej) => { sock.once('open', () => res()); sock.once('error', rej) }),
  }
  open.push(client)
  return client
}

describe('局域网直连的端到端加密握手', () => {
  it('带公钥的客户端:握手成功,hello/ready 走密文,invoke 通', async () => {
    const identity = generateIdentity()
    const { gw } = await boot({ 'a:b': (_ctx, n) => (n as number) + 1 }, { identity })
    const c = e2eClient(gw.port, identity.publicKey)

    const hello = await c.next((f) => f.t === 'hello')
    expect(hello).toMatchObject({ t: 'hello', version: '9.9.9', authRequired: false })
    expect(await c.next((f) => f.t === 'ready')).toMatchObject({ t: 'ready', methods: ['a:b'] })
    expect(c.fails).toEqual([])

    c.send({ t: 'req', id: 1, ch: 'a:b', args: [41] })
    expect(await c.next((f) => f.t === 'res')).toEqual({ t: 'res', id: 1, ok: true, value: 42 })
  })

  it('★加密那条路上令牌照样要:auth 之后才 ready', async () => {
    const identity = generateIdentity()
    const { gw } = await boot({ 'a:b': () => 1 }, { identity, token: '密码' })
    const c = e2eClient(gw.port, identity.publicKey)

    expect(await c.next((f) => f.t === 'hello')).toMatchObject({ authRequired: true })
    c.send({ t: 'auth', token: '密码' })
    expect(await c.next((f) => f.t === 'ready')).toMatchObject({ t: 'ready' })
  })

  it('★★老客户端(不带公钥、等对面先说话)照旧明文能连能 invoke', async () => {
    const identity = generateIdentity()
    // ★这条是**唯一**真的要等窗口过完的:明文客户端连上什么都不发,等对面先说 hello。
    const { gw } = await boot({ 'a:b': () => '明文' }, { identity, e2eGraceMs: 30 })
    const c = plainClient(gw.port)

    expect(await c.next((f) => f.t === 'hello')).toMatchObject({ t: 'hello', protocol: 1 })
    await c.next((f) => f.t === 'ready')
    c.send({ t: 'req', id: 7, ch: 'a:b', args: [] })
    expect(await c.next((f) => f.t === 'res')).toEqual({ t: 'res', id: 7, ok: true, value: '明文' })
  })

  it('★第一帧不是 hs-init 就走明文,而且那一帧**不能被吃掉**', async () => {
    const identity = generateIdentity()
    const { gw } = await boot({ 'a:b': () => 1 }, { identity })
    const c = plainClient(gw.port)
    await c.opened
    // 老客户端不会这么干,但「先说话」的客户端必须不丢帧 —— 嗅探那一帧是被缓冲的,
    // 走明文时必须补回给 serveConnection,否则它静默消失。
    c.send({ t: 'ping' })
    expect(await c.next((f) => f.t === 'pong')).toEqual({ t: 'pong' })
  })

  it('网关没有身份(identity 没给)时,hs-init 退回明文,不炸', async () => {
    const { gw } = await boot({ 'a:b': () => 1 })
    const c = plainClient(gw.port)
    await c.opened
    c.sendRaw(JSON.stringify({ t: 'hs-init', epk: 'AAAA' }))
    // 明文那套照常开口。那一帧解不成协议帧,被 serveConnection 当坏帧丢掉。
    expect(await c.next((f) => f.t === 'hello')).toMatchObject({ t: 'hello' })
  })

  it('公钥不对的客户端连不上:验签过不去', async () => {
    const identity = generateIdentity()
    const other = generateIdentity()
    const { gw } = await boot({ 'a:b': () => 1 }, { identity })
    const c = e2eClient(gw.port, other.publicKey)
    await c.closed
    expect(c.fails.join()).toContain('证明不了自己')
  })

  it('嗅探窗口过完才发 hello —— 窗口内不许有任何明文流出', async () => {
    const identity = generateIdentity()
    const { gw } = await boot({ 'a:b': () => 1 }, { identity, e2eGraceMs: 300 })
    const c = plainClient(gw.port)
    await c.opened
    await new Promise((r) => setTimeout(r, 120))
    expect(c.frames).toEqual([])          // 还在窗口里 —— 一个字都没发
    await c.next((f) => f.t === 'hello')  // 窗口过完,照旧 hello
  })
})
