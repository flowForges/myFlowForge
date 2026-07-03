import { describe, it, expect, vi } from 'vitest'
import { makeHttp } from './http'

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
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
})
