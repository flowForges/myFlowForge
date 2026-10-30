// fetch 封装:开流前的超时、取消转发、HTTP 错误归一成 ModelError
import type { ModelError } from './types'

const MAX_MESSAGE = 500

/** postStream 抛出的失败;调用方取 .error 写进 done{error} */
export class ModelFailure extends Error {
  constructor(readonly error: ModelError) {
    super(error.message)
    this.name = 'ModelFailure'
  }
}

// 从常见错误体里取可读信息:{error:{message}} / {error:"..."} / {message} / {detail}
function messageOf(status: number, bodyText: string): string {
  const text = bodyText.trim()
  if (!text) return `HTTP ${status}`
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const err = j.error as Record<string, unknown> | string | undefined
    const m = (typeof err === 'object' && err ? err.message : err) ?? j.message ?? j.detail
    if (typeof m === 'string' && m) return m.slice(0, MAX_MESSAGE)
  } catch { /* 不是 JSON */ }
  return text.slice(0, MAX_MESSAGE)
}

export function retryAfterMs(headers?: Headers): number | undefined {
  const ms = headers?.get('retry-after-ms')?.trim() // OpenAI 等:毫秒,优先
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms))
  const v = headers?.get('retry-after')?.trim()
  if (!v) return undefined
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000)
  const at = Date.parse(v) // HTTP-date 形式
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

export function toModelError(status: number, bodyText: string, headers?: Headers): ModelError {
  const message = messageOf(status, bodyText)
  if (status === 401 || status === 403) return { kind: 'auth', message, retryable: false }
  if (status === 429) {
    const after = retryAfterMs(headers)
    return { kind: 'rate_limit', message, retryable: true, ...(after !== undefined && { retryAfterMs: after }) }
  }
  if (status >= 500 || status === 408) return { kind: 'unavailable', message, retryable: true }
  return { kind: 'bad_request', message, retryable: false }
}

export interface PostStreamInit extends Omit<RequestInit, 'method' | 'signal'> {
  signal: AbortSignal
  /** 拿到响应头之前的期限;之后的流只受 signal 控制 */
  timeoutMs?: number
  /** 测试注入 */
  fetch?: typeof fetch
  /** 非 2xx 的错误归一(默认 toModelError);供应商有自己的错误码表时替换 */
  mapError?: (status: number, body: string, headers: Headers) => ModelError
}

// 调用方取消时 reject;off() 摘掉监听
function whenAborted(signal: AbortSignal): { promise: Promise<never>; off(): void } {
  let onAbort = () => {}
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
  promise.catch(() => {})
  return { promise, off: () => signal.removeEventListener('abort', onAbort) }
}

export async function postStream(url: string, init: PostStreamInit): Promise<Response> {
  const { signal, timeoutMs, fetch: fetchImpl = fetch, mapError = toModelError, ...rest } = init
  if (signal.aborted) throw signal.reason
  // 超时只管拿响应头;AbortSignal.any 不在调用方 signal 上留 JS 监听
  const timeout = new AbortController()
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => timeout.abort(new Error('timeout')), timeoutMs)

  let res: Response
  try {
    res = await fetchImpl(url, { ...rest, method: 'POST', signal: AbortSignal.any([signal, timeout.signal]) })
  } catch (err) {
    if (signal.aborted) throw signal.reason // 调用方取消:原样抛出,由适配器写 cancelled
    const message = timeout.signal.aborted ? 'timeout' : err instanceof Error ? err.message : String(err)
    throw new ModelFailure({ kind: 'network', message, retryable: true })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const abort = whenAborted(signal)
    let body = ''
    try {
      body = await Promise.race([res.text(), abort.promise]).catch(() => '')
    } finally {
      abort.off()
    }
    if (signal.aborted) {
      res.body?.cancel().catch(() => {})
      throw signal.reason
    }
    throw new ModelFailure(mapError(res.status, body, res.headers))
  }
  return res
}
