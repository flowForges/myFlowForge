import { ProxyAgent } from 'undici'

export interface ExitIpResult {
  ip: string
  /** Human-readable region, e.g. "US · California · San Francisco" or "" if unknown. */
  region: string
  /** Whether the lookup went through the configured term proxy or connected directly. */
  via: 'proxy' | 'direct'
}

// ipinfo.io/json returns { ip, city, region, country, ... } with no auth for light use.
interface IpInfoBody { ip?: unknown; city?: unknown; region?: unknown; country?: unknown }

function toRegion(b: IpInfoBody): string {
  return [b.country, b.region, b.city].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ')
}

type FetchLike = (url: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>

/**
 * Look up the current exit IP + region, going through `proxy` when set (so it reflects the SAME route
 * the providers take — that's the whole point) or connecting directly otherwise. Pure best-effort: a
 * 6s timeout and any network/parse failure reject, and the caller surfaces that as "检测失败" — this
 * never touches provider startup. `doFetch` is injectable for tests.
 */
export async function checkExitIp(
  proxy: string,
  doFetch: FetchLike = fetch as FetchLike,
  timeoutMs = 6000,
): Promise<ExitIpResult> {
  const p = proxy?.trim()
  const via: 'proxy' | 'direct' = p ? 'proxy' : 'direct'
  const dispatcher = p ? new ProxyAgent(p) : undefined
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await doFetch('https://ipinfo.io/json', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ac.signal,
      ...(dispatcher ? { dispatcher } : {}),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const body = await r.json() as IpInfoBody
    const ip = typeof body.ip === 'string' ? body.ip : ''
    if (!ip) throw new Error('no ip in response')
    return { ip, region: toRegion(body), via }
  } finally {
    clearTimeout(t)
  }
}
