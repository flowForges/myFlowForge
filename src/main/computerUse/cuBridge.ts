/**
 * cuBridge — the app-lifetime computer-use socket (spec §4.3). Same JSON-lines wire as the run bridge
 * (`{id, tool, agentId, args}` → `{id, result} | {id, error}`), its own dispatch: only tool `computer`, plus the
 * reply-less control line `{tool:'cancel', args:{id}}` that abandons one of this connection's calls.
 *
 * - Owner-only: the socket lives in a 0700 dir (the config dir, which also holds the 0600 `mcp.cu-<hash>.json` files,
 *   V12, or a private mkdtemp dir when that path is too long for sun_path) and is chmod'ed 0600 after listen.
 * - Bounded: a connection cap, an idle timeout (never while a call is in flight), a request line cap, and reads pause
 *   while a client isn't reading its replies.
 * - Nothing here logs, and nothing reaches the run bridge's audit trail (V11): typed text and tokens pass through
 *   untouched and unrecorded. The token (`agentId`) is checked by the service, never here.
 */
import * as net from 'node:net'
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bridgeAddress } from '../mcp/bridgeAddress'
import { ensurePrivateDir, type ComputerUseService } from './service'
import type { CallMeta } from './types'

/** `signal` fires when the caller abandons the call (a cancel line, or its connection dropped). */
export type CuHandle = (agentId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

export interface CuBridge {
  socketPath: string
  /** where forgeMcpArgs writes the per-token MCP config (pass to the service as `configDir`) */
  configDir: string
  /** the listening server (diagnostics / tests) */
  readonly server: net.Server
  close(): Promise<void>
}

export interface CuBridgeOpts {
  maxConnections?: number
  /** a connection with no call in flight and no traffic for this long is closed (the MCP side reconnects) */
  idleMs?: number
  /** where the long-path fallback socket dir goes (default os.tmpdir()) */
  tmpDir?: string
}

/** A request line is a few hundred bytes (text ≤ 500 chars); anything this long is not ours. */
export const CU_LINE_CAP = 64 * 1024
/** darwin's sun_path is 104 bytes and bind() truncates (bridgeAddress.ts) */
const SUN_PATH_LIMIT = 100
const MAX_CONNECTIONS = 8
const IDLE_MS = 10 * 60_000
/** a client that let this much of our output pile up is not reading: drop it */
const OUT_CAP = 32 * 1024 * 1024
/** per connection, calls in flight at once (the service queue holds 3) */
const INFLIGHT_CAP = 16
const FAILED = '电脑操作组件出错 · 这一步可能已经执行，请重新截图确认'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export async function startCuBridge(dir: string, handle: CuHandle, opts: CuBridgeOpts = {}): Promise<CuBridge> {
  ensurePrivateDir(dir)
  const addr = bridgeAddress(dir, 'cu')
  let socketPath = addr.socketPath
  // bridgeAddress falls back to a fixed name in the shared tmpdir for long paths; use a private dir there instead.
  let privateSockDir: string | null = null
  let onExit: (() => void) | null = null
  if (!addr.isPipe && dirname(socketPath) !== dir) {
    privateSockDir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'fcu-'))
    ensurePrivateDir(privateSockDir)
    socketPath = join(privateSockDir, 'cu.sock')
    const sockDir = privateSockDir
    if (socketPath.length > SUN_PATH_LIMIT) {
      rmSync(sockDir, { recursive: true, force: true })
      throw new Error('cu socket path too long')
    }
    onExit = () => { try { rmSync(sockDir, { recursive: true, force: true }) } catch { /* exiting */ } }
    process.once('exit', onExit)
  }
  if (!addr.isPipe) rmSync(socketPath, { force: true })

  const all = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    all.add(socket)
    socket.once('close', () => all.delete(socket))
    serve(socket, handle, opts.idleMs ?? IDLE_MS)
  })
  server.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS
  const dropRemover = () => { if (onExit) process.removeListener('exit', onExit) }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
  } catch (e) {
    dropRemover()
    onExit?.()
    throw e
  }
  // after listen: a late error (EMFILE on accept, …) must not become an uncaught exception in the main process
  server.on('error', () => { /* the server keeps running or is closed by its owner */ })
  if (!addr.isPipe) chmodSync(socketPath, 0o600)

  return {
    socketPath,
    configDir: dir,
    server,
    close: () => new Promise<void>((res) => {
      for (const s of all) { try { s.destroy() } catch { /* ignore */ } }
      server.close(() => {
        if (!addr.isPipe) rmSync(socketPath, { force: true })
        if (privateSockDir) rmSync(privateSockDir, { recursive: true, force: true })
        dropRemover()
        try {
          for (const f of readdirSync(dir)) if (/^mcp\..*\.json$/.test(f)) rmSync(join(dir, f), { force: true })
        } catch { /* dir gone */ }
        res()
      })
    }),
  }
}

function serve(socket: net.Socket, handle: CuHandle, idleMs: number) {
  socket.setEncoding('utf8')
  const calls = new Map<string, AbortController>()
  let buf = ''
  let blocked = false

  socket.setTimeout(idleMs)
  socket.on('timeout', () => {
    if (calls.size === 0) socket.destroy()
    else socket.setTimeout(idleMs)
  })

  const reply = (payload: object) => {
    if (!socket.writable) return
    const fits = socket.write(JSON.stringify(payload) + '\n')
    if (socket.writableLength > OUT_CAP) { socket.destroy(); return }
    if (!fits && !blocked) { blocked = true; socket.pause() }
  }
  socket.on('drain', () => {
    if (!blocked) return
    blocked = false
    socket.resume()
    pumpLines()
  })

  const pumpLines = () => {
    let idx: number
    while (!blocked && (idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) void processLine(line)
    }
    if (buf.length > CU_LINE_CAP) { buf = ''; socket.destroy() }
  }

  socket.on('data', (chunk: string) => {
    buf += chunk
    pumpLines()
  })
  socket.on('error', () => { /* ECONNRESET etc. */ })
  socket.once('close', () => {
    for (const c of calls.values()) c.abort()
    calls.clear()
  })

  async function processLine(line: string) {
    let req: unknown
    try { req = JSON.parse(line) } catch { return reply({ id: 'unknown', error: 'bad request' }) }
    if (!isObj(req)) return reply({ id: 'unknown', error: 'bad request' })
    const id = typeof req.id === 'string' ? req.id : 'unknown'
    if (req.tool === 'cancel') {
      const target = isObj(req.args) && typeof req.args.id === 'string' ? req.args.id : null
      if (target) calls.get(target)?.abort()
      return
    }
    if (req.tool !== 'computer') return reply({ id, error: 'unknown tool' })
    if (typeof req.agentId !== 'string' || !isObj(req.args)) return reply({ id, error: 'bad request' })
    if (calls.has(id) || calls.size >= INFLIGHT_CAP) return reply({ id, error: 'busy' })
    const ac = new AbortController()
    calls.set(id, ac)
    try {
      const result = await handle(req.agentId, 'computer', req.args, ac.signal)
      if (!ac.signal.aborted) reply({ id, result })
    } catch {
      if (!ac.signal.aborted) reply({ id, error: FAILED })
    } finally {
      if (calls.get(id) === ac) calls.delete(id)
    }
  }
}

// ─── service adapter ──────────────────────────────────────────────────────────

const clientStr = (v: unknown): string | null =>
  typeof v === 'string' ? Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')).slice(0, 64).join('') : null

/** The bridge's `handle` for the service: `{op, args, client}` → `service.handle(token, op, args, {client})`. */
export function cuServiceHandler(svc: Pick<ComputerUseService, 'handle'>): CuHandle {
  return (agentId, _tool, a, signal) => {
    const meta: CallMeta = {}
    if (signal) meta.signal = signal
    if (isObj(a.client)) {
      const name = clientStr(a.client.name), version = clientStr(a.client.version)
      if (name !== null && version !== null) meta.client = { name, version }
    }
    return svc.handle(agentId, typeof a.op === 'string' ? a.op : '', isObj(a.args) ? a.args : {}, meta)
  }
}
