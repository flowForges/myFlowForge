import net from 'node:net'
import { FrameDecoder, encodeFrame } from './framing'
import type { KernelEvent } from './events'
import type { WorkerMethodName, WorkerParams, WorkerResult } from './rpc'

export interface MffaiClient {
  call<M extends WorkerMethodName>(method: M, params?: WorkerParams<M>): Promise<WorkerResult<M>>
  onEvent(cb: (e: KernelEvent) => void): () => void
  onClose(cb: () => void): () => void
  close(): void
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export async function connectClient(opts: { addr: string; token: string }): Promise<MffaiClient> {
  const sock = net.connect(opts.addr)
  sock.setEncoding('utf8')
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })

  let nextId = 1
  let closed = false
  const pending = new Map<number, Pending>()
  const eventCbs = new Set<(e: KernelEvent) => void>()
  const closeCbs = new Set<() => void>()

  const decoder = new FrameDecoder(() => { /* 忽略坏帧 */ })
  sock.on('data', (chunk: string) => {
    for (const m of decoder.push(chunk) as Array<Record<string, any>>) {
      if (typeof m.id === 'number') {
        const p = pending.get(m.id)
        if (!p) continue
        pending.delete(m.id)
        if (m.error) {
          const err = new Error(m.error.message ?? 'rpc error') as Error & { code?: number; data?: unknown }
          err.code = m.error.code
          err.data = m.error.data
          p.reject(err)
        } else p.resolve(m.result)
      } else if (m.method === 'event') {
        for (const cb of [...eventCbs]) {
          try { cb(m.params as KernelEvent) } catch { /* 订阅者异常不影响连接 */ }
        }
      }
    }
  })
  const onGone = () => {
    if (closed) return
    closed = true
    for (const p of pending.values()) p.reject(new Error('connection closed'))
    pending.clear()
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
      pending.set(id, { resolve, reject })
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
    call: call as MffaiClient['call'],
    onEvent(cb) { eventCbs.add(cb); return () => void eventCbs.delete(cb) },
    onClose(cb) { closeCbs.add(cb); return () => void closeCbs.delete(cb) },
    close() { sock.destroy() },
  }
}
