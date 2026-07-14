import { describe, it, expect } from 'vitest'
import { makeProxyFetch, makeContentFetch } from './proxyFetch'

// The update check + download use in-process undici fetch, which ignores HTTP(S)_PROXY env
// vars by design. When the user configures a proxy, calls must carry an explicit ProxyAgent
// dispatcher or they fail behind a proxy (a common case for this app's users).
describe('makeProxyFetch', () => {
  it('attaches a dispatcher when a proxy is configured', async () => {
    let seen: any
    const base = (async (_u: string, init: any) => { seen = init; return { ok: true } }) as unknown as typeof fetch
    await makeProxyFetch('http://127.0.0.1:7890', base)('https://api', {})
    expect(seen.dispatcher).toBeDefined()
  })

  it('omits the dispatcher when no proxy is set', async () => {
    let seen: any
    const base = (async (_u: string, init: any) => { seen = init; return { ok: true } }) as unknown as typeof fetch
    await makeProxyFetch('', base)('https://api', {})
    expect(seen.dispatcher).toBeUndefined()
  })

  it('treats whitespace-only proxy as unset', async () => {
    let seen: any
    const base = (async (_u: string, init: any) => { seen = init; return { ok: true } }) as unknown as typeof fetch
    await makeProxyFetch('   ', base)('https://api', {})
    expect(seen.dispatcher).toBeUndefined()
  })

  it('preserves the caller init options', async () => {
    let seen: any
    const base = (async (_u: string, init: any) => { seen = init; return { ok: true } }) as unknown as typeof fetch
    await makeProxyFetch('http://p', base)('https://api', { method: 'POST' })
    expect(seen.method).toBe('POST')
  })
})

describe('makeContentFetch (proxy-first, direct fallback)', () => {
  it('no proxy → plain direct fetch (no dispatcher)', async () => {
    let seen: any
    const base = (async (_u: string, init: any) => { seen = init; return { ok: true } }) as unknown as typeof fetch
    await makeContentFetch('', base)('https://cdn', {})
    expect(seen?.dispatcher).toBeUndefined()
  })

  it('proxy set but fetch through it throws → falls back to a direct fetch', async () => {
    const calls: any[] = []
    const base = (async (_u: string, init: any) => {
      calls.push(init)
      if (init?.dispatcher) throw new Error('proxy unreachable')
      return { ok: true, direct: true }
    }) as unknown as typeof fetch
    const r: any = await makeContentFetch('http://127.0.0.1:9', base)('https://cdn', {})
    expect(r.direct).toBe(true)          // got the direct result
    expect(calls.length).toBe(2)          // tried proxy, then direct
    expect(calls[0].dispatcher).toBeDefined()
    expect(calls[1].dispatcher).toBeUndefined()
  })

  // A socks url reduces to the case above: undici's ProxyAgent constructs fine but the request through
  // it throws (http/https only), so the fetch-time catch falls back to direct — covered by the test above.
})
