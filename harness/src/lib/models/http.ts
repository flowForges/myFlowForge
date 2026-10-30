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

function retryAfterMs(headers?: Headers): number | undefined {
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
}

export async function postStream(url: string, init: PostStreamInit): Promise<Response> {
  const { signal, timeoutMs, fetch: fetchImpl = fetch, ...rest } = init
  if (signal.aborted) throw signal.reason
  const ac = new AbortController()
  const onAbort = () => ac.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    ac.abort(new Error('timeout'))
  }, timeoutMs)

  let res: Response
  try {
    res = await fetchImpl(url, { ...rest, method: 'POST', signal: ac.signal })
  } catch (err) {
    signal.removeEventListener('abort', onAbort)
    if (signal.aborted && !timedOut) throw err // 调用方取消:原样抛出,由适配器写 cancelled
    const message = timedOut ? 'timeout' : err instanceof Error ? err.message : String(err)
    throw new ModelFailure({ kind: 'network', message, retryable: true })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    signal.removeEventListener('abort', onAbort)
    const body = await res.text().catch(() => '')
    throw new ModelFailure(toModelError(res.status, body, res.headers))
  }
  return res
}
