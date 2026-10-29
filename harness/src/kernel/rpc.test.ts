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
import { connectClient, FrameDecoder, MAX_FRAME_BYTES, encodeFrame, type KernelEvent, type MffaiClient } from '../protocol/index'
import loopEcho from '../plugins/loop-echo'

let dir: string
let kernel: Kernel
let closers: Array<() => unknown> = []
const TOKEN = 'tok'
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-rpc-'))
  kernel = await createKernel({ dataDir: dir, plugins: [loopEcho] })
  closers = [() => kernel.close()]
})
afterEach(async () => {
  for (const c of closers.reverse()) await Promise.resolve(c()).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const sockPath = () => join(dir, 'w.sock')
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
async function prompt(c: MffaiClient, text = 'hi') {
  const { sessionId } = await c.call('session.create', { commandId: 'c' + Math.random() })
  await c.call('session.prompt', { commandId: 'p' + Math.random(), sessionId, text })
}

describe('rpc server + client', () => {
  it('wrong token -> unauthorized and closed', async () => {
    await serve()
    await expect(client(sockPath(), 'bad')).rejects.toThrow('unauthorized')
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
    expect(await c.call('hello', { clientVersion: 'x', protocolVersion: 2 })).toMatchObject({ compatible: false, version: HARNESS_VERSION })
    expect(await c.call('hello', { clientVersion: 'x', protocolVersion: 1 })).toMatchObject({ compatible: true })
  })

  it('omitted params become {} and errors map to RpcError/-32603', async () => {
    await serve()
    const c = await client()
    expect((await c.call('status')).state).toBe('running')
    await expect(c.call('nope' as any, {})).rejects.toMatchObject({ code: expect.any(Number) })
  })

  it('non-RpcError throw -> -32603 with message; RpcError keeps code/data', async () => {
    const addr = join(dir, 'e.sock')
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
    const addr = join(dir, 'h.sock')
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
