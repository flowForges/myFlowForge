import net from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { ERR_UNAUTHORIZED, FrameDecoder, FrameOverflowError, PROTOCOL_VERSION, encodeFrame } from '../protocol/index'
import type { EventLog } from './eventLog'
import { RpcError } from './rpcError'

export interface RpcConn {
  send(msg: object): void
}

export interface RpcServerOpts {
  addr: string
  token: string
  version: string
  handle: (method: string, params: any, conn: RpcConn) => Promise<unknown>
  // 提供则支持 events.subscribe(工作进程);监管控制口不需要
  events?: EventLog
}

const ERR_PARSE = -32700
const ERR_INVALID_REQUEST = -32600
const ERR_METHOD_NOT_FOUND = -32601
const ERR_INTERNAL = -32603

// POSIX:路径已存在时,有人在听就拒绝,没人听(崩溃遗留)才清掉
async function clearStale(addr: string): Promise<void> {
  if (process.platform === 'win32' || !existsSync(addr)) return
  const live = await new Promise<boolean>((resolve) => {
    const s = net.connect(addr)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); resolve(false) })
  })
  if (live) throw new Error('address in use')
  try { unlinkSync(addr) } catch { /* 已被清掉 */ }
}

export async function startRpcServer(opts: RpcServerOpts): Promise<{ close(): Promise<void> }> {
  if (process.platform !== 'win32') mkdirSync(dirname(opts.addr), { recursive: true })
  await clearStale(opts.addr)

  const conns = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    conns.add(sock)
    sock.setEncoding('utf8')
    let authed = false
    let unsubscribe: (() => void) | undefined
    const send = (msg: object) => {
      if (!sock.destroyed && sock.writable) sock.write(encodeFrame(msg))
    }
    const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })
    const fail = (id: unknown, code: number, message: string, data?: unknown) =>
      send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } })
    const conn: RpcConn = { send }

    const subscribe = (id: unknown, after: unknown) => {
      if (!opts.events) return fail(id, ERR_METHOD_NOT_FOUND, 'method not found: events.subscribe')
      const events = opts.events
      if (typeof after !== 'number' || after < 0) return fail(id, ERR_INVALID_REQUEST, 'invalid params')
      const last = events.lastSeq()
      if (after > last) return reply(id, { reset: true, lastSeq: last })
      unsubscribe?.()
      reply(id, { ok: true })
      // 以下同步完成:补齐与挂监听之间不会插入新事件
      let sent = after
      const push = (e: { seq: number }) => {
        if (e.seq <= sent) return
        sent = e.seq
        send({ jsonrpc: '2.0', method: 'event', params: e })
      }
      for (const e of events.after(after)) push(e)
      unsubscribe = events.onAppend(push)
    }

    const dispatch = async (m: Record<string, any>) => {
      const id = m.id
      const method = m.method
      if (typeof method !== 'string') return fail(id ?? null, ERR_INVALID_REQUEST, 'invalid request')
      const params = m.params ?? {}
      if (!authed) {
        if (method === 'auth' && params.token === opts.token) {
          authed = true
          return reply(id, { ok: true })
        }
        fail(id ?? null, ERR_UNAUTHORIZED, 'unauthorized')
        sock.end()
        return
      }
      try {
        if (method === 'auth') return reply(id, { ok: true })
        if (method === 'hello') {
          return reply(id, {
            version: opts.version,
            protocolVersion: PROTOCOL_VERSION,
            compatible: params.protocolVersion === PROTOCOL_VERSION,
          })
        }
        if (method === 'events.subscribe') return subscribe(id, params.after)
        reply(id, await opts.handle(method, params, conn))
      } catch (err) {
        if (err instanceof RpcError) fail(id, err.code, err.message, err.data)
        else fail(id, ERR_INTERNAL, err instanceof Error ? err.message : String(err))
      }
    }

    const decoder = new FrameDecoder((_line, err) => {
      if (err instanceof FrameOverflowError) {
        sock.destroy()
        return
      }
      fail(null, ERR_PARSE, 'parse error')
    })
    sock.on('data', (chunk: string) => {
      for (const m of decoder.push(chunk)) {
        if (sock.destroyed) break
        void dispatch(m as Record<string, any>)
      }
    })
    sock.on('error', () => { /* close 随后触发 */ })
    sock.on('close', () => {
      conns.delete(sock)
      unsubscribe?.()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.addr, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of conns) s.destroy()
        server.close(() => resolve())
      }),
  }
}
