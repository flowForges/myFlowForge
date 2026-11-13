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
    expect(handle).toHaveBeenCalledWith('cu.TOKEN', 'computer', args)
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
