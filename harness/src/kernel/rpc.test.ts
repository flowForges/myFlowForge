import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import { startRpcServer } from './rpcServer'
import { RpcError } from './rpcError'
import { HARNESS_VERSION } from './version'
import {
  PROTOCOL_VERSION, clientProof, connectClient, connectControlClient, FrameDecoder, MAX_FRAME_BYTES, encodeFrame, newNonce, proofEquals, serverProof,
  type KernelEvent, type MffaiClient,
} from '../protocol/index'
import loopEcho from '../plugins/loop-echo'

let dir: string
let kernel: Kernel
let closers: Array<() => unknown> = []
const TOKEN = 'tok'
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-rpc-'))
  kernel = await createKernel({ dataDir: dir, plugins: [loopEcho], secrets: { osBackend: false } })
  closers = [() => kernel.close()]
})
afterEach(async () => {
  for (const c of closers.reverse()) await Promise.resolve(c()).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const sockPath = (name = 'w') =>
  process.platform === 'win32' ? `\\\\.\\pipe\\mffai-test-${name}-${process.pid}-${Date.now()}` : join(dir, `${name}.sock`)
async function serve(addr = sockPath()) {
  const s = await startRpcServer({
    addr, token: TOKEN, version: HARNESS_VERSION, events: kernel.events,
    handle: (m, p) => kernel.handle(m, p),
  })
  closers.push(() => s.close())
  return s
}
async function client(addr = sockPath(), token = TOKEN): Promise<MffaiClient> {
  const c = await connectClient({ addr, token })
  closers.push(() => c.close())
  return c
}
const wait = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise(r => setTimeout(r, 5))
  expect(fn()).toBe(true)
}
const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 5))
  return fn()
}

/** 手写的原始连接:记录收到的每一帧 */
async function raw(addr = sockPath()) {
  const sock = net.connect(addr)
  sock.setEncoding('utf8')
  sock.on('error', () => {})
  const got: any[] = []
  const dec = new FrameDecoder()
  sock.on('data', (d: string) => got.push(...dec.push(d)))
  let isClosed = false
  const closed = new Promise<void>(r => sock.once('close', () => { isClosed = true; r() }))
  await new Promise(r => sock.once('connect', r))
  closers.push(() => sock.destroy())
  const send = (m: object) => sock.write(encodeFrame({ jsonrpc: '2.0', ...m }))
  const reply = async (id: unknown) => {
    await until(() => isClosed || got.some(g => g.id === id))
    return got.find(g => g.id === id)
  }
  return { sock, got, closed, send, reply, isClosed: () => isClosed }
}
type Raw = Awaited<ReturnType<typeof raw>>

/** 在原始连接上走完 challenge → verify;返回线上出现过的值 */
async function handshake(r: Raw, token = TOKEN, clientNonce = newNonce()) {
  r.send({ id: 'c', method: 'auth.challenge', params: { clientNonce } })
  const ch = (await r.reply('c')).result as { serverNonce: string; proof: string }
  expect(proofEquals(ch.proof, serverProof(TOKEN, clientNonce, ch.serverNonce))).toBe(true)
  const proof = clientProof(token, ch.serverNonce, clientNonce)
  r.send({ id: 'v', method: 'auth.verify', params: { proof } })
  return { clientNonce, serverNonce: ch.serverNonce, proof, verify: await r.reply('v') }
}

async function prompt(c: MffaiClient, text = 'hi') {
  const { sessionId } = await c.call('session.create', { commandId: 'c' + Math.random() })
  await c.call('session.prompt', { commandId: 'p' + Math.random(), sessionId, text })
}

describe('rpc server + client', () => {
  it('wrong token -> unauthorized and closed', async () => {
    await serve()
    // 客户端 token 不对:服务端 proof 对不上,客户端自己就拒绝
    await expect(client(sockPath(), 'bad')).rejects.toThrow('unauthorized')
    // 服务端视角:错 token 算出的客户端 proof → -32002 并断开
    const r = await raw()
    const h = await handshake(r, 'bad')
    expect(h.verify.error.code).toBe(-32002)
    await r.closed
    r.send({ id: 9, method: 'session.create', params: { commandId: 'x' } })
    expect(kernel.events.after(0).some(e => e.type === 'session.created')).toBe(false)
  })

  it('handshake happy path on a raw socket, then methods work', async () => {
    await serve()
    const r = await raw()
    const h = await handshake(r)
    expect(h.verify.result).toEqual({ ok: true })
    r.send({ id: 2, method: 'hello', params: { clientVersion: 'x', protocolVersion: PROTOCOL_VERSION } })
    expect((await r.reply(2)).result).toMatchObject({ compatible: true })
    // token 本身从没上线路
    expect(JSON.stringify(r.got)).not.toContain(TOKEN)
  })

  it('auth.verify before auth.challenge -> unauthorized and closed', async () => {
    await serve()
    const r = await raw()
    r.send({ id: 1, method: 'auth.verify', params: { proof: clientProof(TOKEN, newNonce(), newNonce()) } })
    expect((await r.reply(1)).error.code).toBe(-32002)
    await r.closed
  })

  it('a second auth.challenge (before or after verify) -> unauthorized and closed', async () => {
    await serve()
    const r = await raw()
    r.send({ id: 1, method: 'auth.challenge', params: { clientNonce: newNonce() } })
    expect((await r.reply(1)).result.serverNonce).toBeDefined()
    r.send({ id: 2, method: 'auth.challenge', params: { clientNonce: newNonce() } })
    expect((await r.reply(2)).error.code).toBe(-32002)
    await r.closed

    const r2 = await raw()
    expect((await handshake(r2)).verify.result).toEqual({ ok: true })
    r2.send({ id: 3, method: 'auth.challenge', params: { clientNonce: newNonce() } })
    expect((await r2.reply(3)).error.code).toBe(-32002)
    await r2.closed
  })

  it('auth.verify after success is out of order -> unauthorized and closed', async () => {
    await serve()
    const r = await raw()
    const h = await handshake(r)
    r.send({ id: 3, method: 'auth.verify', params: { proof: h.proof } })
    expect((await r.reply(3)).error.code).toBe(-32002)
    await r.closed
  })

  it('bad clientNonce -> unauthorized and closed', async () => {
    await serve()
    for (const clientNonce of ['short', 'a'.repeat(42) + '=', 42, undefined]) {
      const r = await raw()
      r.send({ id: 1, method: 'auth.challenge', params: { clientNonce } })
      expect((await r.reply(1)).error.code).toBe(-32002)
      await r.closed
    }
  })

  it('a captured client proof replayed on a new connection is refused (fresh serverNonce)', async () => {
    await serve()
    const first = await raw()
    const h = await handshake(first)
    expect(h.verify.result).toEqual({ ok: true })
    const r = await raw()
    // 同一个 clientNonce,服务端给的是新 serverNonce
    r.send({ id: 1, method: 'auth.challenge', params: { clientNonce: h.clientNonce } })
    const ch = (await r.reply(1)).result
    expect(ch.serverNonce).not.toBe(h.serverNonce)
    r.send({ id: 2, method: 'auth.verify', params: { proof: h.proof } })
    expect((await r.reply(2)).error.code).toBe(-32002)
    await r.closed
  })

  it('no handshake within authTimeoutMs -> closed; challenged-but-never-verified too', async () => {
    const addr = sockPath('to')
    const s = await startRpcServer({ addr, token: TOKEN, version: 'v', authTimeoutMs: 100, handle: async () => null })
    closers.push(() => s.close())
    const idle = await raw(addr)
    const half = await raw(addr)
    half.send({ id: 1, method: 'auth.challenge', params: { clientNonce: newNonce() } })
    await half.reply(1)
    const t0 = Date.now()
    await Promise.all([idle.closed, half.closed])
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('old-style auth {token} -> unauthorized and closed', async () => {
    await serve()
    const r = await raw()
    r.send({ id: 1, method: 'auth', params: { token: TOKEN } })
    expect((await r.reply(1)).error.code).toBe(-32002)
    await r.closed
  })

  it('client never sends auth.verify to a server that cannot prove the token', async () => {
    const addr = sockPath('fake')
    const frames: any[] = []
    const socks: net.Socket[] = []
    const fake = net.createServer((sk) => {
      socks.push(sk)
      sk.setEncoding('utf8')
      sk.on('error', () => {})
      const dec = new FrameDecoder()
      sk.on('data', (d: string) => {
        for (const m of dec.push(d) as any[]) {
          frames.push(m)
          if (m.method === 'auth.challenge') sk.write(encodeFrame({ jsonrpc: '2.0', id: m.id, result: { serverNonce: newNonce(), proof: newNonce() } }))
          else if (m.method === 'auth.verify') sk.write(encodeFrame({ jsonrpc: '2.0', id: m.id, result: { ok: true } }))
        }
      })
    })
    await new Promise<void>(r => fake.listen(addr, r))
    closers.push(() => new Promise(r => { for (const sk of socks) sk.destroy(); fake.close(r) }))
    await expect(connectClient({ addr, token: TOKEN, timeoutMs: 1000 })).rejects.toThrow('unauthorized')
    await expect(connectControlClient({ addr, token: TOKEN, timeoutMs: 1000 })).rejects.toThrow('unauthorized')
    // 客户端主动断开
    expect(await until(() => socks.length === 2 && socks.every(sk => sk.destroyed || sk.readableEnded))).toBe(true)
    await new Promise(r => setTimeout(r, 50))
    expect(frames.map(f => f.method)).toEqual(['auth.challenge', 'auth.challenge'])
    expect(JSON.stringify(frames)).not.toContain(TOKEN)
  })

  it('request before auth gets -32002 and the socket closes', async () => {
    await serve()
    const sock = net.connect(sockPath())
    sock.setEncoding('utf8')
    const got: any[] = []
    const dec = new FrameDecoder()
    sock.on('data', (d: string) => got.push(...dec.push(d)))
    await new Promise(r => sock.once('connect', r))
    sock.write(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'status', params: {} }))
    await new Promise(r => sock.once('close', r))
    expect(got[0].error.code).toBe(-32002)
  })

  it('hello compatibility', async () => {
    await serve()
    const c = await client()
    expect(await c.call('hello', { clientVersion: 'x', protocolVersion: 2 })).toMatchObject({ compatible: false, version: HARNESS_VERSION, protocolVersion: 3 })
    expect(await c.call('hello', { clientVersion: 'x', protocolVersion: PROTOCOL_VERSION })).toMatchObject({ compatible: true })
  })

  it('omitted params become {} and errors map to RpcError/-32603', async () => {
    await serve()
    const c = await client()
    expect((await c.call('status')).state).toBe('running')
    await expect(c.call('nope' as any, {})).rejects.toMatchObject({ code: expect.any(Number) })
  })

  it('non-RpcError throw -> -32603 with message; RpcError keeps code/data', async () => {
    const addr = sockPath('e')
    const s = await startRpcServer({
      addr, token: TOKEN, version: 'v',
      handle: async (m) => { if (m === 'status') throw new RpcError(-32003, 'busy', { a: 1 }); throw new Error('kaboom') },
    })
    closers.push(() => s.close())
    const c = await client(addr)
    await expect(c.call('status')).rejects.toMatchObject({ code: -32003, message: 'busy', data: { a: 1 } })
    await expect(c.call('snapshot')).rejects.toMatchObject({ code: -32603, message: 'kaboom' })
  })

  it('prompt then subscribe after 0 delivers all events in order', async () => {
    await serve()
    const c = await client()
    await prompt(c)
    await wait(() => kernel.events.after(0).some(e => e.type === 'turn.ended'))
    const got: KernelEvent[] = []
    c.onEvent(e => got.push(e))
    expect(await c.call('events.subscribe', { after: 0 })).toEqual({ ok: true })
    const all = kernel.events.after(0)
    await wait(() => got.length === all.length)
    expect(got.map(e => e.seq)).toEqual(all.map(e => e.seq))
  })

  it('subscribe mid-stream: backlog + live, no gaps or duplicates', async () => {
    await serve()
    const c = await client()
    const got: KernelEvent[] = []
    c.onEvent(e => got.push(e))
    await prompt(c, 'first')
    await c.call('events.subscribe', { after: 0 })
    await wait(() => kernel.events.after(0).some(e => e.type === 'turn.ended'))
    await prompt(c, 'second')
    await wait(() => kernel.events.after(0).filter(e => e.type === 'turn.ended').length === 2)
    const all = kernel.events.after(0)
    await wait(() => got.length === all.length)
    expect(got.map(e => e.seq)).toEqual(all.map(e => e.seq))
  })

  it('subscribe with after > lastSeq -> reset', async () => {
    await serve()
    const c = await client()
    const last = kernel.events.lastSeq()
    expect(await c.call('events.subscribe', { after: last + 5 })).toEqual({ reset: true, lastSeq: last })
  })

  it('pending calls reject on close; onClose fires', async () => {
    const addr = sockPath('h')
    const s = await startRpcServer({ addr, token: TOKEN, version: 'v', handle: () => new Promise(() => {}) })
    closers.push(() => s.close())
    const c = await client(addr)
    let closedCb = false
    c.onClose(() => { closedCb = true })
    const p = c.call('status')
    await s.close()
    await expect(p).rejects.toThrow('connection closed')
    expect(closedCb).toBe(true)
  })

  it('pipelined bad request then a challenge then prompt never runs the prompt', async () => {
    await serve()
    const sock = net.connect(sockPath())
    sock.on('error', () => {})
    await new Promise(r => sock.once('connect', r))
    const closed = new Promise(r => sock.once('close', r))
    sock.resume()
    sock.write(
      encodeFrame({ jsonrpc: '2.0', id: 1, method: 'status', params: {} }) +
      encodeFrame({ jsonrpc: '2.0', id: 2, method: 'auth.challenge', params: { clientNonce: newNonce() } }) +
      encodeFrame({ jsonrpc: '2.0', id: 3, method: 'session.create', params: { commandId: 'zz' } }),
    )
    await closed
    expect(kernel.events.after(0).some(e => e.type === 'session.created')).toBe(false)
  })

  it('empty token is refused', async () => {
    await expect(startRpcServer({ addr: sockPath('t'), token: '', version: 'v', handle: async () => null })).rejects.toThrow('token')
  })

  it('invalid after -> -32602; notifications get no response', async () => {
    await serve()
    const c = await client()
    for (const after of [-1, 1.5, 'x' as any]) {
      await expect(c.call('events.subscribe', { after })).rejects.toMatchObject({ code: -32602 })
    }
    const r = await raw()
    await handshake(r)
    r.sock.write(
      encodeFrame({ jsonrpc: '2.0', method: 'status', params: {} }) +
      encodeFrame({ jsonrpc: '2.0', method: 'nope', params: {} }) +
      encodeFrame({ jsonrpc: '2.0', id: 2, method: 'status', params: {} }),
    )
    await r.reply(2)
    await new Promise(res => setTimeout(res, 50))
    r.sock.destroy()
    expect(r.got.map(g => g.id)).toEqual(['c', 'v', 2])
  })

  it('mid-stream subscribe with after = k > 0 starts at k+1', async () => {
    await serve()
    const c = await client()
    await prompt(c)
    await wait(() => kernel.events.after(0).some(e => e.type === 'turn.ended'))
    const k = 3
    const got: KernelEvent[] = []
    c.onEvent(e => got.push(e))
    await c.call('events.subscribe', { after: k })
    const all = kernel.events.after(k)
    await wait(() => got.length === all.length)
    expect(got[0].seq).toBe(k + 1)
  })

  it('socket that never authenticates is closed after the auth deadline; authed one stays', async () => {
    const addr = sockPath('a')
    const s = await startRpcServer({ addr, token: TOKEN, version: 'v', authTimeoutMs: 50, handle: async () => null })
    closers.push(() => s.close())
    const idle = net.connect(addr)
    idle.on('error', () => {})
    await new Promise(r => idle.once('connect', r))
    const t0 = Date.now()
    await new Promise(r => idle.once('close', r))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40)
    const c = await client(addr)
    await new Promise(r => setTimeout(r, 120))
    expect(await c.call('hello', { clientVersion: 'x', protocolVersion: PROTOCOL_VERSION })).toMatchObject({ compatible: true })
  })

  it('oversized frame closes the connection', async () => {
    await serve()
    const sock = net.connect(sockPath())
    sock.on('error', () => {})
    await new Promise(r => sock.once('connect', r))
    const closed = new Promise(r => sock.once('close', r))
    sock.write('x'.repeat(MAX_FRAME_BYTES + 1))
    await closed
  })

  it.skipIf(process.platform === 'win32')('stale socket file is replaced', async () => {
    writeFileSync(sockPath(), 'junk')
    await serve()
    const c = await client()
    expect((await c.call('status')).state).toBe('running')
  })

  it.skipIf(process.platform === 'win32')('closed (crashed) socket is replaced', async () => {
    const addr = sockPath()
    // 模拟崩溃:子进程监听后被 SIGKILL,socket 文件遗留
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(addr)},()=>console.log('up'))`])
    await new Promise<void>(r => child.stdout.once('data', () => r()))
    child.kill('SIGKILL')
    await new Promise(r => child.once('exit', r))
    expect(existsSync(addr)).toBe(true)
    await serve()
    expect((await (await client()).call('status')).state).toBe('running')
  })

  it('per-call timeoutMs rejects with timeout; control client defaults to a timeout', async () => {
    const addr = sockPath('t')
    const s = await startRpcServer({ addr, token: TOKEN, version: 'v', handle: () => new Promise(() => {}) })
    closers.push(() => s.close())
    const c = await connectClient({ addr, token: TOKEN, timeoutMs: 100 })
    closers.push(() => c.close())
    await expect(c.call('status')).rejects.toThrow('timeout')
    const cc = await connectControlClient({ addr, token: TOKEN, timeoutMs: 100 })
    closers.push(() => cc.close())
    await expect(cc.call('status')).rejects.toThrow('timeout')
    // 超时后连接仍可用
    await expect((cc.call as (m: string, p: unknown) => Promise<unknown>)('hello', { clientVersion: 'x', protocolVersion: PROTOCOL_VERSION })).resolves.toMatchObject({ compatible: true })
  })

  it('timeoutMs bounds connect + handshake as one deadline', async () => {
    const addr = sockPath('silent')
    const socks: net.Socket[] = []
    const silent = net.createServer(sk => { socks.push(sk) /* 接受但从不回 */ })
    await new Promise<void>(r => silent.listen(addr, r))
    closers.push(() => new Promise(r => { for (const sk of socks) sk.destroy(); silent.close(r) }))
    const t0 = Date.now()
    await expect(connectControlClient({ addr, token: TOKEN, timeoutMs: 150 })).rejects.toThrow('timeout')
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('timeoutMs also bounds a server that answers the challenge but never the verify', async () => {
    const addr = sockPath('halfway')
    const socks: net.Socket[] = []
    const srv = net.createServer((sk) => {
      socks.push(sk)
      sk.setEncoding('utf8')
      sk.on('error', () => {})
      const dec = new FrameDecoder()
      sk.on('data', (d: string) => {
        for (const m of dec.push(d) as any[]) {
          if (m.method !== 'auth.challenge') continue
          const serverNonce = newNonce()
          sk.write(encodeFrame({ jsonrpc: '2.0', id: m.id, result: { serverNonce, proof: serverProof(TOKEN, m.params.clientNonce, serverNonce) } }))
        }
      })
    })
    await new Promise<void>(r => srv.listen(addr, r))
    closers.push(() => new Promise(r => { for (const sk of socks) sk.destroy(); srv.close(r) }))
    const t0 = Date.now()
    await expect(connectClient({ addr, token: TOKEN, timeoutMs: 150 })).rejects.toThrow('timeout')
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('a live listener is never stolen', async () => {
    await serve()
    await expect(serve()).rejects.toThrow('address in use')
    const c = await client()
    expect((await c.call('status')).state).toBe('running')
  })

  it.skipIf(process.platform === 'win32')('works on the long-path tmpdir fallback address', async () => {
    const { runtimePaths } = await import('../protocol/index')
    const p = runtimePaths('/' + 'a'.repeat(120) + '/mff-ai')
    closers.push(() => rmSync(p.workerAddr, { force: true }))
    await serve(p.workerAddr)
    expect((await (await client(p.workerAddr)).call('status')).state).toBe('running')
  })
})
