import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RELAY_SOURCE } from './relay'

// 中转的纯逻辑(不需要 bwrap):用 process.execPath 跑内联源码,TCP 127.0.0.1 ↔ 测试自己起的 Unix socket

const posix = process.platform !== 'win32'

let R = ''
let sock = ''
let server: Server
const peers = new Set<Socket>()
const kids = new Set<ChildProcess>()

beforeAll(async () => {
  if (!posix) return
  R = mkdtempSync(join(tmpdir(), 'mffai-relay-'))
  sock = join(R, 'u.sock')
  // "代理":收到什么回什么,前面加 "echo:";收到 "hold" 就一直不关
  server = createServer(c => {
    peers.add(c)
    c.on('close', () => peers.delete(c))
    c.on('error', () => {})
    c.on('data', d => { c.write(`echo:${d}`) })
    c.on('end', () => c.end())
  })
  await new Promise<void>(r => server.listen(sock, r))
})

afterEach(() => {
  for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL')
  kids.clear()
})

afterAll(async () => {
  if (!posix) return
  for (const p of peers) p.destroy()
  await new Promise<void>(r => server.close(() => r()))
  rmSync(R, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  await new Promise<void>(r => s.close(() => r()))
  return port
}

interface Run { code: number | null; signal: NodeJS.Signals | null; out: string; err: string }

function relay(port: number, command: string, env: NodeJS.ProcessEnv = {}, onOut?: (s: string, k: ChildProcess) => void): Promise<Run> {
  const k = spawn(process.execPath, ['-e', RELAY_SOURCE, String(port), sock, '/bin/sh', '-c', command], {
    env: { PATH: process.env.PATH, NODE: process.execPath, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  kids.add(k)
  let out = ''
  let err = ''
  k.stdout!.on('data', d => { out += d; onOut?.(out, k) })
  k.stderr!.on('data', d => { err += d })
  return new Promise(r => k.on('close', (code, signal) => r({ code, signal, out, err })))
}

// 沙箱里的命令:连 127.0.0.1:<port>,发一句,打印回来的全部字节
const client = (port: number, msg: string) =>
  `"$NODE" -e 'const s=require("net").connect(${port},"127.0.0.1");s.on("error",()=>{});s.end(${JSON.stringify(msg)});let b="";s.on("data",d=>b+=d);s.on("close",()=>process.stdout.write("got["+b+"]"))'`

describe.skipIf(!posix)('relay', () => {
  it('forwards bytes both ways between TCP 127.0.0.1 and the unix socket, and passes the exit code', async () => {
    const port = await freePort()
    const r = await relay(port, `${client(port, 'ping')}; exit 7`)
    expect(r.out).toBe('got[echo:ping]')
    expect(r.code).toBe(7)
    expect(r.signal).toBeNull()
  }, 20_000)

  it('exit 0 → 0', async () => {
    const port = await freePort()
    expect((await relay(port, 'true')).code).toBe(0)
  }, 20_000)

  it("passes the child's terminating signal through", async () => {
    const port = await freePort()
    const r = await relay(port, 'kill -TERM $$')
    expect(r.signal).toBe('SIGTERM')
  }, 20_000)

  it('the child does not see ELECTRON_RUN_AS_NODE (the relay itself keeps it)', async () => {
    const port = await freePort()
    const r = await relay(port, 'echo "[${ELECTRON_RUN_AS_NODE-unset}]"', { ELECTRON_RUN_AS_NODE: '1', KEEP_ME: 'k' })
    expect(r.out).toBe('[unset]\n')
    const r2 = await relay(port, 'echo "[$KEEP_ME]"', { ELECTRON_RUN_AS_NODE: '1', KEEP_ME: 'k' })
    expect(r2.out).toBe('[k]\n')
  }, 20_000)

  it('exits when the child exits even while a client connection is still open', async () => {
    const port = await freePort()
    let held: Socket | undefined
    const t0 = Date.now()
    const r = await relay(port, 'echo ready; sleep 1; exit 3', {}, (out) => {
      if (held || !out.includes('ready')) return
      held = connect(port, '127.0.0.1')
      held.on('error', () => {})
      held.write('hold')
    })
    expect(r.code).toBe(3)
    expect(Date.now() - t0).toBeLessThan(8_000)
    held?.destroy()
  }, 20_000)

  it('a refused unix socket closes the TCP client instead of hanging', async () => {
    const port = await freePort()
    const k = spawn(process.execPath, ['-e', RELAY_SOURCE, String(port), join(R, 'nobody.sock'), '/bin/sh', '-c', `${client(port, 'x')}`], {
      env: { PATH: process.env.PATH, NODE: process.execPath }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    kids.add(k)
    let out = ''
    k.stdout!.on('data', d => { out += d })
    const code = await new Promise(r => k.on('close', r))
    expect(out).toBe('got[]')
    expect(code).toBe(0)
  }, 20_000)

  it('cannot listen → fails fast with a non-zero code and never runs the command', async () => {
    const blocker = createServer()
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    const { port } = blocker.address() as AddressInfo
    try {
      const r = await relay(port, 'echo ran')
      expect(r.code).not.toBe(0)
      expect(r.out).toBe('')
      expect(r.err).toMatch(/relay/)
    } finally {
      await new Promise<void>(r => blocker.close(() => r()))
    }
  }, 20_000)
})
