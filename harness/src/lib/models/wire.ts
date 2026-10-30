// OpenAI / Anthropic 线协议适配器共用的网络层:流式请求 + 取消语义 + 轻量 GET
import { ModelFailure, postStream, toModelError } from './http'
import { parseSSE, type SSEEvent } from './sse'
import type { Account, ModelEvent, ModelRequest } from './types'

const HEADER_TIMEOUT_MS = 30_000

export const joinUrl = (base: string, path: string) => base.replace(/\/+$/, '') + path

export function openaiHeaders(account: Account): Record<string, string> {
  return { 'content-type': 'application/json', accept: 'text/event-stream', ...(account.apiKey && { authorization: `Bearer ${account.apiKey}` }) }
}

/** Anthropic 线:只发 x-api-key,不带 Authorization */
export function anthropicHeaders(account: Account): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    ...(account.apiKey && { 'x-api-key': account.apiKey }),
  }
}

const cancelled = (): ModelEvent => ({ type: 'done', reason: 'cancelled' })

/** POST 并解码 SSE;错误一律以 done{error} 结束,取消以 done{cancelled} 结束 */
export async function* streamWire(
  url: string,
  headers: Record<string, string>,
  body: object,
  req: ModelRequest,
  decode: (events: AsyncIterable<SSEEvent>) => AsyncIterable<ModelEvent>,
): AsyncIterable<ModelEvent> {
  let res: Response
  try {
    res = await postStream(url, { headers, body: JSON.stringify(body), signal: req.signal, timeoutMs: HEADER_TIMEOUT_MS })
  } catch (err) {
    if (req.signal.aborted) return yield cancelled()
    if (err instanceof ModelFailure) return yield { type: 'done', reason: 'error', error: err.error }
    return yield { type: 'done', reason: 'error', error: { kind: 'network', message: err instanceof Error ? err.message : String(err), retryable: true } }
  }
  if (!res.body) return yield { type: 'done', reason: 'error', error: { kind: 'network', message: 'empty response body', retryable: true } }
  try {
    for await (const ev of decode(parseSSE(res.body))) {
      // 取消后读流报错会被解码器记成 network,这里改写为 cancelled
      if (ev.type === 'done' && req.signal.aborted && ev.reason === 'error') return yield cancelled()
      yield ev
      if (ev.type === 'done') return
    }
  } catch (err) {
    if (req.signal.aborted) return yield cancelled()
    return yield { type: 'done', reason: 'error', error: { kind: 'network', message: err instanceof Error ? err.message : String(err), retryable: true } }
  }
  yield req.signal.aborted ? cancelled() : { type: 'done', reason: 'error', error: { kind: 'network', message: 'stream ended without done', retryable: true } }
}

/** GET JSON;非 2xx 抛 ModelFailure。tolerate404 时 404 返回 undefined */
export async function getJson(url: string, headers: Record<string, string>, opts: { tolerate404?: boolean } = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(HEADER_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { headers, signal: timeout })
  } catch (err) {
    throw new ModelFailure({ kind: 'network', message: err instanceof Error ? err.message : String(err), retryable: true })
  }
  const text = await res.text().catch(() => '')
  if (res.status === 404 && opts.tolerate404) return undefined
  if (!res.ok) throw new ModelFailure(toModelError(res.status, text, res.headers))
  try { return JSON.parse(text) } catch { return {} }
}

export function modelIds(json: unknown): { id: string; name?: string }[] {
  const data = (json as { data?: unknown } | undefined)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap((m: { id?: unknown; display_name?: unknown; name?: unknown }) => {
    if (typeof m?.id !== 'string') return []
    const name = typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' ? m.name : undefined
    return [{ id: m.id, ...(name && name !== m.id && { name }) }]
  })
}
