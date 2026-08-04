import { describe, it, expect, vi } from 'vitest'
import { checkExitIp } from './exitIp'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

describe('checkExitIp', () => {
  it('parses ip + region and reports via:direct when no proxy', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ ip: '1.2.3.4', country: 'US', region: 'California', city: 'San Francisco' }))
    const r = await checkExitIp('', doFetch)
    expect(r.ip).toBe('1.2.3.4')
    expect(r.region).toBe('US · California · San Francisco')
    expect(r.via).toBe('direct')
    expect(doFetch).toHaveBeenCalledWith('https://ipinfo.io/json', expect.objectContaining({ method: 'GET' }))
  })

  it('reports via:proxy when a proxy is configured', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ ip: '5.6.7.8' }))
    const r = await checkExitIp('http://127.0.0.1:7897', doFetch)
    expect(r.via).toBe('proxy')
    expect(r.ip).toBe('5.6.7.8')
    expect(r.region).toBe('')  // no geo fields → empty region, not a crash
  })

  it('rejects on non-ok HTTP', async () => {
    const doFetch = vi.fn(async () => jsonResponse({}, false, 403))
    await expect(checkExitIp('', doFetch)).rejects.toThrow('HTTP 403')
  })

  it('rejects when the body has no ip', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ city: 'Nowhere' }))
    await expect(checkExitIp('', doFetch)).rejects.toThrow(/no ip/)
  })

  it('rejects (aborts) on timeout', async () => {
    // A fetch that respects the abort signal and never resolves otherwise.
    const doFetch = vi.fn((_url: string, init?: RequestInit & { dispatcher?: unknown }) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
      }))
    await expect(checkExitIp('', doFetch, 5)).rejects.toThrow(/abort/)
  })
})
