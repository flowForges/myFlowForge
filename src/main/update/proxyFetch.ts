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

// For OPTIONAL content (NSFW / wallpapers / pet packs): try the configured proxy first (some users can
// only reach workers.dev / jsDelivr via a proxy), but fall back to a DIRECT fetch if the proxy throws —
// e.g. a SOCKS url (undici's ProxyAgent is http/https only and throws), a down/misrouted proxy. This
// turns "无法连接内容服务" (proxy blew up) into a working direct request whenever the network allows it.
export function makeContentFetch(proxyUrl?: string, base: typeof fetch = fetch) {
  const proxy = proxyUrl?.trim()
  const direct = (url: string, init?: RequestInit) => base(url, init)
  if (!proxy) return direct
  let proxied: ((url: string, init?: RequestInit) => Promise<Response>) | null = null
  try {
    const dispatcher = new ProxyAgent(proxy)
    proxied = (url, init) => base(url, { ...(init ?? {}), dispatcher } as RequestInit)
  } catch { proxied = null } // bad proxy url (e.g. socks5://) → construction throws → use direct
  if (!proxied) return direct
  return async (url: string, init?: RequestInit) => {
    try { return await proxied!(url, init) } catch { return direct(url, init) } // proxy unreachable → direct
  }
}
