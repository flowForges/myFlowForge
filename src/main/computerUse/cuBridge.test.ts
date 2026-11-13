import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as net from 'node:net'
import { startCuBridge, cuServiceHandler, CU_LINE_CAP, type CuBridge } from './cuBridge'
import type { ComputerUseService } from './service'

function connectTo(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

function sendRecv(socket: net.Socket, req: object | string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) {
        socket.off('data', onData)
        try { resolve(JSON.parse(buf.slice(0, idx))) } catch (e) { reject(e) }
      }
    }
    socket.on('data', onData)
    socket.write((typeof req === 'string' ? req : JSON.stringify(req)) + '\n')
  })
}

let root: string
let dir: string
let bridge: CuBridge | undefined
const sockets: net.Socket[] = []
const open = async (p: string) => { const s = await connectTo(p); sockets.push(s); return s }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cub-'))
  dir = join(root, 'computer-use')
})
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  if (bridge) { await bridge.close(); bridge = undefined }
  rmSync(root, { recursive: true, force: true })
})

describe('startCuBridge', () => {
  it('a computer request reaches handle with the agent id and args; the result comes back', async () => {
    const handle = vi.fn(async () => ({ ok: true, text: 'done' }))
    bridge = await startCuBridge(dir, handle)
    const s = await open(bridge.socketPath)
    const args = { op: 'click', args: { x: 1, y: 2 }, client: { name: 'claude-code', version: '2.0' } }
    const r = await sendRecv(s, { id: 'r1', tool: 'computer', agentId: 'cu.TOKEN', args })
    expect(r).toEqual({ id: 'r1', result: { ok: true, text: 'done' } })
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith('cu.TOKEN', 'computer', args, expect.any(AbortSignal))
  })

  it('every other tool (the forge bridge set included) gives error and never reaches handle', async () => {
    const handle = vi.fn(async () => ({}))
    bridge = await startCuBridge(dir, handle)
    const s = await open(bridge.socketPath)
    for (const tool of ['read_context', 'write_artifact', 'ask', 'handoff', 'heartbeat', 'propose_plan', 'delegate', 'Computer', '']) {
      const r = await sendRecv(s, { id: `x-${tool}`, tool, agentId: 'cu.TOKEN', args: {} })
      expect(r.id).toBe(`x-${tool}`)
      expect(typeof r.error).toBe('string')
      expect(r).not.toHaveProperty('result')
    }
    expect(handle).not.toHaveBeenCalled()
  })

  it('malformed lines get an error and never reach handle', async () => {
    const handle = vi.fn(async () => ({}))
    bridge = await startCuBridge(dir, handle)
    const s = await open(bridge.socketPath)
    expect(await sendRecv(s, '{not json')).toMatchObject({ error: expect.any(String) })
    expect(await sendRecv(s, '[1,2]')).toMatchObject({ error: expect.any(String) })
    expect(await sendRecv(s, { id: 'n', tool: 'computer', agentId: 7, args: {} })).toMatchObject({ id: 'n', error: expect.any(String) })
    expect(await sendRecv(s, { id: 'm', tool: 'computer', agentId: 'cu.T', args: 'x' })).toMatchObject({ id: 'm', error: expect.any(String) })
    expect(handle).not.toHaveBeenCalled()
  })

  it('a handle that throws answers a fixed message, never the thrown text', async () => {
    bridge = await startCuBridge(dir, async () => { throw new Error('SECRET-TYPED-TEXT') })
    const s = await open(bridge.socketPath)
    const r = await sendRecv(s, { id: 't', tool: 'computer', agentId: 'cu.T', args: { op: 'type', args: { text: 'SECRET-TYPED-TEXT' } } })
    expect(r.id).toBe('t')
    expect(String(r.error)).not.toContain('SECRET')
  })

  it('the socket is 0600, and the config dir (also the socket dir) is 0700 even when it existed as 0755', async () => {
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    chmodSync(dir, 0o755)
    bridge = await startCuBridge(dir, async () => ({}))
    expect(bridge.configDir).toBe(dir)
    expect(statSync(bridge.socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(bridge.configDir).mode & 0o777).toBe(0o700)
    expect(statSync(dirname(bridge.socketPath)).mode & 0o777).toBe(0o700)
  })

  it('an over-long dir puts the socket in a private 0700 temp dir; the config dir stays the given one (never tmpdir)', async () => {
    dir = join(root, 'x'.repeat(60), 'y'.repeat(60), 'computer-use')
    bridge = await startCuBridge(dir, async () => ({ ok: true }))
    expect(bridge.configDir).toBe(dir)
    expect(bridge.configDir).not.toBe(tmpdir())
    expect(bridge.socketPath.length).toBeLessThanOrEqual(100)
    expect(statSync(dirname(bridge.socketPath)).mode & 0o777).toBe(0o700)
    expect(statSync(bridge.socketPath).mode & 0o777).toBe(0o600)
    const s = await open(bridge.socketPath)
    expect(await sendRecv(s, { id: 'l', tool: 'computer', agentId: 'cu.T', args: {} })).toEqual({ id: 'l', result: { ok: true } })
    const sockDir = dirname(bridge.socketPath)
    await bridge.close(); bridge = undefined
    expect(existsSync(sockDir)).toBe(false)
  })

  it('a line longer than the cap drops the connection without calling handle', async () => {
    const handle = vi.fn(async () => ({}))
    bridge = await startCuBridge(dir, handle)
    const s = await open(bridge.socketPath)
    const closed = new Promise<void>((r) => s.once('close', () => r()))
    s.on('error', () => {})
    s.write('{"id":"big","tool":"computer","agentId":"cu.T","args":{"x":"' + 'a'.repeat(CU_LINE_CAP + 10))
    await closed
    expect(handle).not.toHaveBeenCalled()
  })

  it('restarts on the same dir over a stale socket file; close removes the socket and the mcp.*.json files', async () => {
    bridge = await startCuBridge(dir, async () => ({ n: 1 }))
    const first = bridge.socketPath
    writeFileSync(join(dir, 'mcp.cu-abc.json'), '{}')
    writeFileSync(join(dir, 'keep.txt'), 'x')
    await bridge.close(); bridge = undefined
    expect(existsSync(first)).toBe(false)
    expect(existsSync(join(dir, 'mcp.cu-abc.json'))).toBe(false)
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('x')
    writeFileSync(first, 'stale')
    bridge = await startCuBridge(dir, async () => ({ n: 2 }))
    expect(bridge.socketPath).toBe(first)
    const s = await open(bridge.socketPath)
    expect(await sendRecv(s, { id: 'a', tool: 'computer', agentId: 'cu.T', args: {} })).toEqual({ id: 'a', result: { n: 2 } })
  })

  it('source: no forge bridge audit, no logging, no electron (V11/V12)', () => {
    const src = readFileSync(join(__dirname, 'cuBridge.ts'), 'utf8')
    expect(src).not.toMatch(/forgeBridge|appendAudit|appendMessage/)
    expect(src).not.toMatch(/console\.|logError|debugLog/)
    expect(src).not.toMatch(/from ['"]electron['"]/)
  })
})

describe('cuServiceHandler', () => {
  const svcWith = () => {
    const handle = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, text: 'ok' }))
    return { handle, svc: { handle } as unknown as ComputerUseService }
  }

  it('maps {op, args, client} onto service.handle(token, op, args, {client})', async () => {
    const { svc, handle } = svcWith()
    const r = await cuServiceHandler(svc)('cu.TOKEN', 'computer', { op: 'click', args: { x: 3, y: 4 }, client: { name: 'codex', version: '0.154' } })
    expect(r).toEqual({ ok: true, text: 'ok' })
    expect(handle).toHaveBeenCalledWith('cu.TOKEN', 'click', { x: 3, y: 4 }, { client: { name: 'codex', version: '0.154' } })
  })

  it('a missing or junk client is dropped; long or control-laden values are cut and made single-line', async () => {
    const { svc, handle } = svcWith()
    const h = cuServiceHandler(svc)
    await h('cu.T', 'computer', { op: 'screenshot', args: {} })
    expect(handle).toHaveBeenLastCalledWith('cu.T', 'screenshot', {}, {})
    await h('cu.T', 'computer', { op: 'screenshot', args: {}, client: { name: 5, version: 'x' } })
    expect(handle).toHaveBeenLastCalledWith('cu.T', 'screenshot', {}, {})
    await h('cu.T', 'computer', { op: 'screenshot', args: {}, client: { name: 'a\nb\u0000' + 'z'.repeat(200), version: '1' } })
    const meta = handle.mock.calls.at(-1)![3] as unknown as { client: { name: string } }
    expect(meta.client.name.length).toBeLessThanOrEqual(64)
    expect(meta.client.name).not.toMatch(/[\n\u0000]/)
  })

  it('a non-string op or non-object args still goes to the service, which refuses (token first: touches nothing)', async () => {
    const { svc, handle } = svcWith()
    await cuServiceHandler(svc)('cu.T', 'computer', { op: 7, args: null })
    expect(handle).toHaveBeenLastCalledWith('cu.T', '', {}, {})
  })
})

// ───────────────────────── review fixes ─────────────────────────

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('startCuBridge hardening (Task 6 review)', () => {
  it('a cancel line aborts that call\'s signal on the same connection only, and gets no reply', async () => {
    const signals: AbortSignal[] = []
    bridge = await startCuBridge(dir, (_a, _t, _args, signal) => { signals.push(signal!); return new Promise(() => {}) })
    const s1 = await open(bridge.socketPath)
    const s2 = await open(bridge.socketPath)
    let s1Got = ''
    s1.on('data', (c) => { s1Got += c.toString() })
    s1.write(JSON.stringify({ id: 'r1', tool: 'computer', agentId: 'cu.T', args: {} }) + '\n')
    s2.write(JSON.stringify({ id: 'r1', tool: 'computer', agentId: 'cu.T', args: {} }) + '\n')
    await tick(30)
    expect(signals).toHaveLength(2)
    s2.write(JSON.stringify({ id: 'k', tool: 'cancel', agentId: 'cu.T', args: { id: 'nope' } }) + '\n')
    s1.write(JSON.stringify({ id: 'k', tool: 'cancel', agentId: 'cu.T', args: { id: 'r1' } }) + '\n')
    await tick(30)
    const aborted = signals.map((x) => x.aborted)
    expect(aborted.filter(Boolean)).toHaveLength(1)
    expect(s1Got).toBe('')
  })

  it('a dropped connection aborts its calls in flight', async () => {
    const signals: AbortSignal[] = []
    bridge = await startCuBridge(dir, (_a, _t, _args, signal) => { signals.push(signal!); return new Promise(() => {}) })
    const s = await open(bridge.socketPath)
    s.write(JSON.stringify({ id: 'r', tool: 'computer', agentId: 'cu.T', args: {} }) + '\n')
    await tick(30)
    s.destroy()
    await tick(30)
    expect(signals[0].aborted).toBe(true)
  })

  it('keeps a server error listener, so a late server error cannot crash the app', async () => {
    bridge = await startCuBridge(dir, async () => ({}))
    expect(bridge.server.listenerCount('error')).toBeGreaterThan(0)
    expect(() => bridge!.server.emit('error', new Error('late'))).not.toThrow()
  })

  it('caps connections', async () => {
    bridge = await startCuBridge(dir, async () => ({ ok: true }), { maxConnections: 2 })
    await open(bridge.socketPath); await open(bridge.socketPath)
    const third = await open(bridge.socketPath)
    const closed = await Promise.race([new Promise((r) => third.once('close', () => r(true))), tick(500).then(() => false)])
    expect(closed).toBe(true)
  })

  it('closes an idle connection, but not one with a call in flight', async () => {
    const gate: { release?: () => void } = {}
    bridge = await startCuBridge(dir, () => new Promise((r) => { gate.release = () => r({ ok: true }) }), { idleMs: 60 })
    const idle = await open(bridge.socketPath)
    const busy = await open(bridge.socketPath)
    busy.write(JSON.stringify({ id: 'b', tool: 'computer', agentId: 'cu.T', args: {} }) + '\n')
    const idleClosed = new Promise((r) => idle.once('close', () => r(true)))
    let busyClosed = false
    busy.once('close', () => { busyClosed = true })
    expect(await Promise.race([idleClosed, tick(1000).then(() => false)])).toBe(true)
    await tick(200)
    expect(busyClosed).toBe(false)
    gate.release!()
  })

  it('stops reading from a client that does not read its replies (backpressure)', async () => {
    const big = 'x'.repeat(512 * 1024)
    let calls = 0
    bridge = await startCuBridge(dir, async () => { calls++; return { ok: true, text: big } })
    const s = await open(bridge.socketPath)
    s.pause()
    for (let i = 0; i < 200; i++) {
      s.write(JSON.stringify({ id: `p${i}`, tool: 'computer', agentId: 'cu.T', args: {} }) + '\n')
      await tick(2)
    }
    await tick(100)
    expect(calls).toBeLessThan(200)
  })

  it('decodes UTF-8 split across chunks', async () => {
    const got: unknown[] = []
    bridge = await startCuBridge(dir, async (_a, _t, args) => { got.push(args); return { ok: true } })
    const s = await open(bridge.socketPath)
    const line = Buffer.from(JSON.stringify({ id: 'u', tool: 'computer', agentId: 'cu.T', args: { t: '电脑操作' } }) + '\n')
    const cut = line.indexOf(Buffer.from('脑')) + 1
    const reply = new Promise((r) => s.once('data', r))
    s.write(line.subarray(0, cut))
    await tick(20)
    s.write(line.subarray(cut))
    await reply
    expect(got).toEqual([{ t: '电脑操作' }])
  })

  it('source: no umask', () => {
    expect(readFileSync(join(__dirname, 'cuBridge.ts'), 'utf8')).not.toMatch(/umask/)
  })

  it('a fallback socket path that would still exceed sun_path is refused', async () => {
    const longTmp = join(root, 'z'.repeat(110))
    mkdirSync(longTmp, { recursive: true })
    await expect(startCuBridge(join(root, 'q'.repeat(120)), async () => ({}), { tmpDir: longTmp })).rejects.toThrow()
  })

  it('the fallback dir is removed at process exit even without close()', async () => {
    const before = process.listeners('exit')
    bridge = await startCuBridge(join(root, 'w'.repeat(120)), async () => ({}))
    const added = process.listeners('exit').filter((l) => !before.includes(l))
    expect(added).toHaveLength(1)
    const sockDir = dirname(bridge.socketPath)
    ;(added[0] as () => void)()
    expect(existsSync(sockDir)).toBe(false)
    await bridge.close(); bridge = undefined
    expect(process.listeners('exit').filter((l) => !before.includes(l))).toHaveLength(0)
  })
})
