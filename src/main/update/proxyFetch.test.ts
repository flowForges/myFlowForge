import { describe, it, expect } from 'vitest'
import { makeProxyFetch } from './proxyFetch'

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
