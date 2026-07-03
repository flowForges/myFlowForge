import { describe, it, expect } from 'vitest'
import { fetchCodexUsage, normalizeCodex, readCodexToken } from './codex'
import type { HttpClient, StatusbarUsage } from './types'

const NOW = 1_700_000_000_000

describe('normalizeCodex', () => {
  it('maps primary→5h, secondary→weekly', () => {
    const u = normalizeCodex({ rate_limit: {
      primary_window: { used_percent: 31, resets_in_seconds: 3600 },
      secondary_window: { used_percent: 45, resets_in_seconds: 86400 },
    } }, NOW)
    expect(u.window5h).toEqual({ used: 31, limit: 100, resetAt: NOW + 3_600_000 })
    expect(u.weekly).toEqual({ used: 45, limit: 100, resetAt: NOW + 86_400_000 })
    expect(u.label).toBe('Codex')
  })
  it('tolerates missing rate_limit (no windows)', () => {
    const u = normalizeCodex({}, NOW)
    expect(u.window5h).toBeUndefined()
    expect(u.weekly).toBeUndefined()
  })
})

describe('readCodexToken', () => {
  it('reads access_token from auth.json', () => {
    const token = readCodexToken({
      home: '/h',
      readFile: (p) => { expect(p).toBe('/h/.codex/auth.json'); return JSON.stringify({ tokens: { access_token: 'AT' } }) },
    })
    expect(token).toBe('AT')
  })
  it('throws when file missing', () => {
    expect(() => readCodexToken({ home: '/h', readFile: () => { throw new Error('ENOENT') } })).toThrow(/Codex 未登录/)
  })
  it('throws when auth.json is malformed JSON', () => {
    expect(() => readCodexToken({ home: '/h', readFile: () => 'not-json' })).toThrow(/Codex 未登录/)
  })
})

describe('fetchCodexUsage (RPC first, wham HTTP fallback)', () => {
  const RPC_USAGE: StatusbarUsage = { window5h: { used: 31, limit: 100 }, label: 'Codex' }
  const WHAM_RAW = { rate_limit: { primary_window: { used_percent: 62 } } }
  const httpSpy = (): { http: HttpClient; calls: { url: string; headers: Record<string, string> }[] } => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const http: HttpClient = {
      getJson: async (url, headers) => { calls.push({ url, headers }); return WHAM_RAW },
      postJson: async () => { throw new Error('unexpected post') },
    }
    return { http, calls }
  }

  it('returns app-server RPC data without touching HTTP when RPC succeeds', async () => {
    const { http, calls } = httpSpy()
    const usage = await fetchCodexUsage(http, undefined, undefined, { fetchRpc: async () => RPC_USAGE })
    expect(usage).toEqual(RPC_USAGE)
    expect(calls).toHaveLength(0)
  })

  it('falls back to the wham HTTP endpoint when RPC fails', async () => {
    const { http, calls } = httpSpy()
    const usage = await fetchCodexUsage(
      http,
      { home: '/h', readFile: () => JSON.stringify({ tokens: { access_token: 'AT' } }) },
      undefined,
      { fetchRpc: async () => { throw new Error('RPC 超时') } },
    )
    expect(calls).toEqual([{ url: 'https://chatgpt.com/backend-api/wham/usage', headers: { authorization: 'Bearer AT' } }])
    expect(usage.window5h?.used).toBe(62)
  })

  it('skips RPC entirely when a user-pasted credential is provided', async () => {
    const { http, calls } = httpSpy()
    let rpcCalled = false
    const usage = await fetchCodexUsage(http, undefined, ' PASTED ', {
      fetchRpc: async () => { rpcCalled = true; return RPC_USAGE },
    })
    expect(rpcCalled).toBe(false)
    expect(calls[0]?.headers).toEqual({ authorization: 'Bearer PASTED' })
    expect(usage.window5h?.used).toBe(62)
  })

  it('surfaces the fallback error when RPC and HTTP both fail', async () => {
    const http: HttpClient = {
      getJson: async () => { throw new Error('HTTP 403') },
      postJson: async () => { throw new Error('unexpected post') },
    }
    await expect(fetchCodexUsage(
      http,
      { home: '/h', readFile: () => JSON.stringify({ tokens: { access_token: 'AT' } }) },
      undefined,
      { fetchRpc: async () => { throw new Error('RPC 超时') } },
    )).rejects.toThrow(/HTTP 403/)
  })
})
