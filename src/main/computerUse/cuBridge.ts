/**
 * cuBridge — the app-lifetime computer-use socket (spec §4.3). Same JSON-lines wire as the run bridge
 * (`{id, tool, agentId, args}` → `{id, result} | {id, error}`), its own dispatch: only tool `computer`.
 *
 * - Socket and config dir are owner-only: the dir is 0700 (it also holds the 0600 `mcp.cu-<hash>.json` files, V12),
 *   the socket is created under umask 077 and chmod'ed 0600.
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

export type CuHandle = (agentId: string, tool: string, args: Record<string, unknown>) => Promise<unknown>

export interface CuBridge {
  socketPath: string
  /** where forgeMcpArgs writes the per-token MCP config (pass to the service as `configDir`) */
  configDir: string
  close(): Promise<void>
}

/** A request line is a few hundred bytes (text ≤ 500 chars); anything this long is not ours. */
export const CU_LINE_CAP = 64 * 1024
const FAILED = '电脑操作组件出错 · 没有执行'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export async function startCuBridge(dir: string, handle: CuHandle): Promise<CuBridge> {
  ensurePrivateDir(dir)
  const addr = bridgeAddress(dir, 'cu')
  let socketPath = addr.socketPath
  // bridgeAddress falls back to a fixed name in the shared tmpdir for long paths; use a private dir there instead.
  let privateSockDir: string | null = null
  if (!addr.isPipe && dirname(socketPath) !== dir) {
    privateSockDir = mkdtempSync(join(tmpdir(), 'fcu-'))
    ensurePrivateDir(privateSockDir)
    socketPath = join(privateSockDir, 'cu.sock')
  }
  if (!addr.isPipe) rmSync(socketPath, { force: true })

  const all = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    all.add(socket)
    socket.once('close', () => all.delete(socket))
    serve(socket, handle)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    let prev: number | null = null
    try { prev = process.umask(0o177) } catch { /* workers can't set umask; chmod below still applies */ }
    try {
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    } finally {
      if (prev !== null) process.umask(prev)
    }
  })
  if (!addr.isPipe) chmodSync(socketPath, 0o600)

  return {
    socketPath,
    configDir: dir,
    close: () => new Promise<void>((res) => {
      for (const s of all) { try { s.destroy() } catch { /* ignore */ } }
      server.close(() => {
        if (!addr.isPipe) rmSync(socketPath, { force: true })
        if (privateSockDir) rmSync(privateSockDir, { recursive: true, force: true })
        try {
          for (const f of readdirSync(dir)) if (/^mcp\..*\.json$/.test(f)) rmSync(join(dir, f), { force: true })
        } catch { /* dir gone */ }
        res()
      })
    }),
  }
}

function serve(socket: net.Socket, handle: CuHandle) {
  let buf = ''
  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let idx: number
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) void processLine(line, socket, handle)
    }
    if (buf.length > CU_LINE_CAP) { buf = ''; socket.destroy() }
  })
  socket.on('error', () => { /* ECONNRESET etc. */ })
}

async function processLine(line: string, socket: net.Socket, handle: CuHandle) {
  let req: unknown
  try { req = JSON.parse(line) } catch { return reply(socket, { id: 'unknown', error: 'bad request' }) }
  if (!isObj(req)) return reply(socket, { id: 'unknown', error: 'bad request' })
  const id = typeof req.id === 'string' ? req.id : 'unknown'
  if (req.tool !== 'computer') return reply(socket, { id, error: 'unknown tool' })
  if (typeof req.agentId !== 'string' || !isObj(req.args)) return reply(socket, { id, error: 'bad request' })
  try {
    reply(socket, { id, result: await handle(req.agentId, 'computer', req.args) })
  } catch {
    reply(socket, { id, error: FAILED })
  }
}

function reply(socket: net.Socket, payload: object) {
  if (socket.writable) socket.write(JSON.stringify(payload) + '\n')
}

// ─── service adapter ──────────────────────────────────────────────────────────

const clientStr = (v: unknown): string | null =>
  typeof v === 'string' ? Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')).slice(0, 64).join('') : null

/** The bridge's `handle` for the service: `{op, args, client}` → `service.handle(token, op, args, {client})`. */
export function cuServiceHandler(svc: Pick<ComputerUseService, 'handle'>): CuHandle {
  return (agentId, _tool, a) => {
    const meta: CallMeta = {}
    if (isObj(a.client)) {
      const name = clientStr(a.client.name), version = clientStr(a.client.version)
      if (name !== null && version !== null) meta.client = { name, version }
    }
    return svc.handle(agentId, typeof a.op === 'string' ? a.op : '', isObj(a.args) ? a.args : {}, meta)
  }
}
