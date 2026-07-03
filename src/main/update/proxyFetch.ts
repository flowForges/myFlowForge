import { ProxyAgent } from 'undici'

// In-process undici fetch ignores HTTP(S)_PROXY env vars by design. When the user has
// configured a proxy (settings.termProxy), the update check + download must pass an explicit
// ProxyAgent dispatcher, or they fail on networks where GitHub is only reachable via a proxy.
// Returns a fetch-like function so both the release-metadata call ({ ok, json }) and the dmg
// download ({ ok, headers, body }) can share it. Proxy-only (no timeout): a large dmg download
// must not be killed by a blanket deadline.
export function makeProxyFetch(proxyUrl?: string, base: typeof fetch = fetch) {
  const proxy = proxyUrl?.trim()
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined
  return (url: string, init?: RequestInit) =>
    base(url, { ...(init ?? {}), ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
}
