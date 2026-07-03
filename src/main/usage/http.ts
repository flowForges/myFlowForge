import { ProxyAgent } from 'undici'
import type { HttpClient } from './types'

// The usage adapters use in-process undici fetch, which (by design) ignores HTTP(S)_PROXY env vars.
// On networks where the provider APIs are only reachable through a local proxy, we must pass an
// explicit undici ProxyAgent dispatcher — otherwise calls fail with 403 / "fetch failed".
export function makeHttp(fetchImpl: typeof fetch, timeoutMs: number, proxyUrl?: string): HttpClient {
  const proxy = proxyUrl?.trim()
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined
  async function call(url: string, init: RequestInit): Promise<unknown> {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetchImpl(url, { ...init, signal: ac.signal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
      if (!r.ok) throw new Error(`HTTP ${r.status}`) // sanitized: status only
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
