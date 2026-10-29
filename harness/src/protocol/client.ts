import net from 'node:net'
import { FrameDecoder, encodeFrame } from './framing'
import type { KernelEvent } from './events'
import type {
  ControlMethodName,
  ControlParams,
  ControlResult,
  WorkerMethodName,
  WorkerParams,
  WorkerResult,
} from './rpc'

export interface MffaiClient {
  call<M extends WorkerMethodName>(method: M, params?: WorkerParams<M>): Promise<WorkerResult<M>>
  onEvent(cb: (e: KernelEvent) => void): () => void
  onClose(cb: () => void): () => void
  close(): void
}

export interface MffaiControlClient {
  call<M extends ControlMethodName>(method: M, params?: ControlParams<M>): Promise<ControlResult<M>>
  close(): void
}

export interface ClientOpts {
  addr: string
  token: string
  // 每次调用(含连接与 auth)的超时;超时 reject Error('timeout')
  timeoutMs?: number
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }

interface Conn {
  call(method: string, params?: unknown): Promise<any>
  onClose(cb: () => void): () => void
  close(): void
}

// 两种客户端共用:连接、分帧、请求配对、超时、auth
async function openConn(opts: ClientOpts, onNotify: (m: Record<string, any>) => void): Promise<Conn> {
  const sock = net.connect(opts.addr)
  sock.setEncoding('utf8')
  await new Promise<void>((resolve, reject) => {
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      sock.destroy()
      reject(new Error('timeout'))
    }, opts.timeoutMs)
    sock.once('connect', () => { clearTimeout(timer); resolve() })
    sock.once('error', (e) => { clearTimeout(timer); reject(e) })
  })

  let nextId = 1
  let closed = false
  const pending = new Map<number, Pending>()
  const closeCbs = new Set<() => void>()
  const settle = (id: number): Pending | undefined => {
    const p = pending.get(id)
    if (!p) return undefined
    pending.delete(id)
    clearTimeout(p.timer)
    return p
  }

  const decoder = new FrameDecoder(() => { /* 忽略坏帧 */ })
  sock.on('data', (chunk: string) => {
    for (const m of decoder.push(chunk) as Array<Record<string, any>>) {
      if (typeof m.id === 'number') {
        const p = settle(m.id)
        if (!p) continue
        if (m.error) {
          const err = new Error(m.error.message ?? 'rpc error') as Error & { code?: number; data?: unknown }
          err.code = m.error.code
          err.data = m.error.data
          p.reject(err)
        } else p.resolve(m.result)
      } else if (typeof m.method === 'string') onNotify(m)
    }
  })
  const onGone = () => {
    if (closed) return
    closed = true
    for (const id of [...pending.keys()]) settle(id)!.reject(new Error('connection closed'))
    for (const cb of [...closeCbs]) {
      try { cb() } catch { /* 忽略 */ }
    }
  }
  sock.on('close', onGone)
  sock.on('error', () => { /* close 随后触发 */ })

  const call = (method: string, params: unknown = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('connection closed'))
      const id = nextId++
      const p: Pending = { resolve, reject }
      if (opts.timeoutMs !== undefined) p.timer = setTimeout(() => settle(id)?.reject(new Error('timeout')), opts.timeoutMs)
      pending.set(id, p)
      sock.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    })

  try {
    await call('auth', { token: opts.token })
  } catch (e) {
    sock.destroy()
    throw (e as Error).message === 'unauthorized' || (e as { code?: number }).code === -32002
      ? new Error('unauthorized')
      : e
  }

  return {
    call,
    onClose(cb) { closeCbs.add(cb); return () => void closeCbs.delete(cb) },
    close() { sock.destroy() },
  }
}

/** 工作进程客户端;默认不设调用超时 */
export async function connectClient(opts: ClientOpts): Promise<MffaiClient> {
  const eventCbs = new Set<(e: KernelEvent) => void>()
  const conn = await openConn(opts, (m) => {
    if (m.method !== 'event') return
    for (const cb of [...eventCbs]) {
      try { cb(m.params as KernelEvent) } catch { /* 订阅者异常不影响连接 */ }
    }
  })
  return {
    call: conn.call as MffaiClient['call'],
    onEvent(cb) { eventCbs.add(cb); return () => void eventCbs.delete(cb) },
    onClose: conn.onClose,
    close: conn.close,
  }
}

/** 监管控制口客户端;默认每次调用 3 s 超时 */
export async function connectControlClient(opts: ClientOpts): Promise<MffaiControlClient> {
  const conn = await openConn({ ...opts, timeoutMs: opts.timeoutMs ?? 3000 }, () => {})
  return { call: conn.call as MffaiControlClient['call'], close: conn.close }
}
