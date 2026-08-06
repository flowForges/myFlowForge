import { ProxyAgent } from 'undici'
import type { HttpClient } from './types'

// The usage adapters use in-process undici fetch, which (by design) ignores HTTP(S)_PROXY env vars.
// On networks where the provider APIs are only reachable through a local proxy, we must pass an
// explicit undici ProxyAgent dispatcher — otherwise calls fail with 403 / "fetch failed".
// A non-2xx response, carrying the bits the scheduler needs to pace retries. The `message` shape
// ("HTTP 429") is load-bearing — usageService.friendly() pattern-matches it to build the user hint.
export class UsageHttpError extends Error {
  readonly status: number
  /** Parsed `Retry-After`, in seconds. Absent when the server didn't say. */
  readonly retryAfterSec?: number
  constructor(status: number, retryAfterSec?: number) {
    super(`HTTP ${status}`)
    this.name = 'UsageHttpError'
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

// `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110). Accept both; ignore garbage.
export function parseRetryAfter(raw: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  const s = (raw ?? '').trim()
  if (!s) return undefined
  if (/^\d+$/.test(s)) return Number(s)
  const at = Date.parse(s)
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - nowMs) / 1000))
}

export function makeHttp(fetchImpl: typeof fetch, timeoutMs: number, proxyUrl?: string): HttpClient {
  const proxy = proxyUrl?.trim()
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined
  async function call(url: string, init: RequestInit): Promise<unknown> {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetchImpl(url, { ...init, signal: ac.signal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
      // sanitized: status only (never the body — it can echo the token back)
      if (!r.ok) throw new UsageHttpError(r.status, parseRetryAfter(r.headers?.get('retry-after')))
      return await r.json()
    } finally {
      clearTimeout(t)
    }
  }
  return {
    getJson: (url, headers) => call(url, { method: 'GET', headers }),
    postJson: (url, headers, body) =>
      call(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
  }
}

export const defaultHttp: HttpClient = makeHttp(fetch, 10_000)
