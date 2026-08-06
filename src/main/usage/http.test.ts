import { describe, it, expect, vi } from 'vitest'
import { makeHttp, parseRetryAfter, UsageHttpError } from './http'

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300, status, json: async () => body,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
  } as unknown as Response
}

describe('makeHttp', () => {
  it('getJson returns parsed json on 200', async () => {
    const f = vi.fn(async () => res(200, { a: 1 }))
    const http = makeHttp(f as unknown as typeof fetch, 1000)
    expect(await http.getJson('https://x', { A: 'b' })).toEqual({ a: 1 })
    expect(f).toHaveBeenCalledOnce()
  })
  it('throws sanitized error on 401 (no body in message)', async () => {
    const f = vi.fn(async () => res(401, { token: 'SECRET' }))
    const http = makeHttp(f as unknown as typeof fetch, 1000)
    await expect(http.getJson('https://x', {})).rejects.toThrow(/401/)
    await expect(http.getJson('https://x', {})).rejects.not.toThrow(/SECRET/)
  })
  it('passes an undici proxy dispatcher when a proxy url is configured', async () => {
    const seen: Record<string, unknown>[] = []
    const f = vi.fn(async (_u: string, init: Record<string, unknown>) => { seen.push(init); return res(200, {}) })
    const http = makeHttp(f as unknown as typeof fetch, 1000, 'http://127.0.0.1:7897')
    await http.getJson('https://x', {})
    expect(seen[0].dispatcher).toBeDefined()
  })
  it('omits dispatcher when no proxy configured', async () => {
    const seen: Record<string, unknown>[] = []
    const f = vi.fn(async (_u: string, init: Record<string, unknown>) => { seen.push(init); return res(200, {}) })
    const http = makeHttp(f as unknown as typeof fetch, 1000, '')
    await http.getJson('https://x', {})
    expect(seen[0].dispatcher).toBeUndefined()
  })

  // 429 的冷却时长以前被整个丢掉(只留 `HTTP 429` 一句),调度器于是只能瞎猜、继续按原频率撞。
  it('429 上带出 status 与 Retry-After 供调度器退避', async () => {
    const f = vi.fn(async () => res(429, {}, { 'Retry-After': '900' }))
    const http = makeHttp(f as unknown as typeof fetch, 1000)
    await expect(http.getJson('https://x', {})).rejects.toMatchObject({
      status: 429, retryAfterSec: 900, message: 'HTTP 429',
    })
  })

  it('没有 Retry-After 时 retryAfterSec 缺省', async () => {
    const f = vi.fn(async () => res(500, {}))
    const http = makeHttp(f as unknown as typeof fetch, 1000)
    await expect(http.getJson('https://x', {})).rejects.toBeInstanceOf(UsageHttpError)
    await expect(http.getJson('https://x', {})).rejects.toMatchObject({ status: 500, retryAfterSec: undefined })
  })

  // 缺 headers 的 fetch 桩(测试里常见)不该把整条请求炸掉。
  it('响应没有 headers 时不抛 TypeError', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response)
    const http = makeHttp(f as unknown as typeof fetch, 1000)
    await expect(http.getJson('https://x', {})).rejects.toThrow(/403/)
  })
})

describe('parseRetryAfter', () => {
  it('delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120)
    expect(parseRetryAfter('  120 ')).toBe(120)
  })
  it('HTTP-date → 距现在的秒数', () => {
    const now = Date.parse('2026-08-06T10:00:00Z')
    expect(parseRetryAfter('Thu, 06 Aug 2026 10:05:00 GMT', now)).toBe(300)
  })
  it('已过期的 HTTP-date 归零,不返回负数', () => {
    const now = Date.parse('2026-08-06T10:10:00Z')
    expect(parseRetryAfter('Thu, 06 Aug 2026 10:05:00 GMT', now)).toBe(0)
  })
  it('缺失或非法一律 undefined', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('soon-ish')).toBeUndefined()
  })
})
