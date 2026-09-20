import { ProxyAgent } from 'undici'

// In-process undici fetch ignores HTTP(S)_PROXY env vars by design. When the user has
// configured a proxy (settings.agentProxy), the update check + download must pass an explicit
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

export interface ContentFetchOpts {
  /**
   * Deadline for the whole request. Omit (or 0) for no deadline — correct for large downloads, wrong
   * for anything the UI waits on: undici's fetch has no total-request timeout of its own, so a hung
   * server or proxy leaves the user staring at a spinner indefinitely.
   */
  timeoutMs?: number
  /**
   * Deadline for the PROXY attempt alone. When it expires we fall back to a direct request instead of
   * waiting out `timeoutMs`. Without this the proxy-first strategy only recovers from proxies that
   * fail LOUDLY (throw); one that accepts the connection and then hangs would never reach the fallback.
   */
  proxyTimeoutMs?: number
}

// AbortSignal.any lands in Node 20.3; fall back to the timeout alone on anything older so a caller's
// own signal is merely ignored rather than the whole request throwing.
function mergeSignals(own: AbortSignal | null | undefined, timeout: AbortSignal): AbortSignal {
  if (!own) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([own, timeout]) : timeout
}

function withDeadline(init: RequestInit | undefined, ms?: number): RequestInit | undefined {
  if (!ms || ms <= 0) return init
  // AbortSignal.timeout rejects with a DOMException named 'TimeoutError' — netErrorHint keys off that
  // to tell "we gave up waiting" apart from "the network refused us".
  return { ...(init ?? {}), signal: mergeSignals(init?.signal, AbortSignal.timeout(ms)) }
}

// For OPTIONAL content (NSFW / wallpapers / pet packs / codex-pets 宠物市场): try the configured proxy
// first (some users can only reach workers.dev / jsDelivr via a proxy), but fall back to a DIRECT fetch
// if the proxy throws OR hangs past `proxyTimeoutMs` — e.g. a SOCKS url (undici's ProxyAgent is
// http/https only and throws), a down/misrouted proxy. This turns "无法连接内容服务" (proxy blew up)
// into a working direct request whenever the network allows it.
export function makeContentFetch(proxyUrl?: string, base: typeof fetch = fetch, opts: ContentFetchOpts = {}) {
  const proxy = proxyUrl?.trim()
  const direct = (url: string, init?: RequestInit) => base(url, withDeadline(init, opts.timeoutMs))
  if (!proxy) return direct
  let proxied: ((url: string, init?: RequestInit) => Promise<Response>) | null = null
  try {
    const dispatcher = new ProxyAgent(proxy)
    // The proxy hop gets the SHORTER of the two deadlines: blowing it just means "try direct instead",
    // so failing fast there costs nothing and buys the fallback real time to succeed.
    const hop = opts.proxyTimeoutMs && opts.timeoutMs
      ? Math.min(opts.proxyTimeoutMs, opts.timeoutMs)
      : (opts.proxyTimeoutMs ?? opts.timeoutMs)
    proxied = (url, init) => base(url, { ...(withDeadline(init, hop) ?? {}), dispatcher } as RequestInit)
  } catch { proxied = null } // bad proxy url (e.g. socks5://) → construction throws → use direct
  if (!proxied) return direct
  return async (url: string, init?: RequestInit) => {
    try { return await proxied!(url, init) } catch { return direct(url, init) } // proxy unreachable/hung → direct
  }
}

/**
 * Turn a raw fetch rejection into something a user can act on. The pet market used to collapse every
 * failure into 「无法连接 codex-pets.net」, which told neither the user nor us whether it was DNS, a
 * dead proxy, or just a slow link.
 */
export function netErrorHint(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  const name = err?.name ?? ''
  const code = err?.cause?.code ?? ''
  const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`
  if (name === 'TimeoutError' || /timeout|ETIMEDOUT|UND_ERR_(CONNECT_)?TIMEOUT/i.test(`${name} ${code} ${msg}`)) {
    return '连接超时 —— 对方站点或你的网络太慢。若在国内访问，通常需要在 设置→终端代理 配一个代理。'
  }
  if (name === 'AbortError') return '请求已取消'
  if (/ENOTFOUND|EAI_AGAIN/i.test(`${code} ${msg}`)) {
    return '域名解析失败 —— 检查网络连接或 DNS；若已配代理，确认代理本身可用。'
  }
  if (/ECONNREFUSED/i.test(`${code} ${msg}`)) return '连接被拒绝 —— 若配了代理，多半是代理没在运行。'
  if (/ECONNRESET|EPIPE/i.test(`${code} ${msg}`)) return '连接被中断 —— 网络不稳定，稍后重试。'
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(`${code} ${msg}`)) return 'TLS 证书校验失败 —— 检查代理或系统时间。'
  return '网络无法连接 —— 若需代理请在 设置→终端代理 填写后重试。'
}
