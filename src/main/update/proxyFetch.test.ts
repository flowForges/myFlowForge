import { describe, it, expect } from 'vitest'
import { makeProxyFetch, makeContentFetch, netErrorHint } from './proxyFetch'

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

  // undici 的 fetch 没有整体超时。不显式给死线,一个挂住的站点/代理就是用户盯着转圈直到天荒地老 ——
  // 宠物市场「无法连接」的主要形态就是这个。
  describe('deadlines', () => {
    it('无 timeoutMs 时不塞 signal(大文件下载不能被死线砍掉)', async () => {
      let seen: any
      const base = (async (_u: string, init: any) => { seen = init; return { ok: true } }) as unknown as typeof fetch
      await makeContentFetch('', base)('https://cdn', {})
      expect(seen?.signal).toBeUndefined()
    })

    it('给了 timeoutMs 就带上一个会到期的 signal', async () => {
      let seen: any
      const base = (async (_u: string, init: any) => { seen = init; return { ok: true } }) as unknown as typeof fetch
      await makeContentFetch('', base, { timeoutMs: 50 })('https://cdn', {})
      expect(seen.signal).toBeInstanceOf(AbortSignal)
      expect(seen.signal.aborted).toBe(false)
      await new Promise(r => setTimeout(r, 80))
      expect(seen.signal.aborted).toBe(true)
      expect(seen.signal.reason?.name).toBe('TimeoutError')
    })

    it('代理挂起(不抛)超过 proxyTimeoutMs → 回退直连', async () => {
      const calls: any[] = []
      const base = (async (_u: string, init: any) => {
        calls.push(init)
        if (init?.dispatcher) {
          // 模拟"接了连接然后不吭声"的代理:只有 signal 到期才结束。以前这种代理永远等不到回退。
          return await new Promise((_res, rej) => {
            init.signal?.addEventListener('abort', () => rej(init.signal.reason))
          })
        }
        return { ok: true, direct: true }
      }) as unknown as typeof fetch
      const r: any = await makeContentFetch('http://127.0.0.1:9', base, { timeoutMs: 5_000, proxyTimeoutMs: 40 })('https://cdn', {})
      expect(r.direct).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0].dispatcher).toBeDefined()
      expect(calls[1].dispatcher).toBeUndefined()
    })

    it('代理那一跳取两个死线里更短的那个', async () => {
      const seen: any[] = []
      const base = (async (_u: string, init: any) => { seen.push(init); return { ok: true } }) as unknown as typeof fetch
      // proxyTimeoutMs(5s) > timeoutMs(1s) → 代理跳不该比整体死线还长
      await makeContentFetch('http://p', base, { timeoutMs: 1_000, proxyTimeoutMs: 5_000 })('https://cdn', {})
      const sig: AbortSignal = seen[0].signal
      expect(sig).toBeInstanceOf(AbortSignal)
      await new Promise(r => setTimeout(r, 30))
      expect(sig.aborted).toBe(false)   // 1s 还没到,只是确认它是有限死线而非 5s 那条
    })
  })
})

describe('netErrorHint', () => {
  it('超时 → 提示网络慢/建议配代理', () => {
    expect(netErrorHint(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))).toContain('超时')
  })
  it('DNS 失败 → 提示解析问题', () => {
    expect(netErrorHint(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toContain('域名解析失败')
  })
  it('连接被拒 → 点名代理没在跑', () => {
    expect(netErrorHint(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toContain('代理')
  })
  it('证书问题单独成句', () => {
    expect(netErrorHint(Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }))).toContain('证书')
  })
  it('认不出的错误退回通用提示,不抛', () => {
    expect(netErrorHint(null)).toContain('网络无法连接')
    expect(netErrorHint(new Error('???'))).toContain('网络无法连接')
  })
})
