import { describe, it, expect } from 'vitest'
import { normalizeGemini, readGeminiToken } from './gemini'

const NOW = 1_700_000_000_000

describe('normalizeGemini', () => {
  it('maps first quota bucket via remainingFraction', () => {
    const u = normalizeGemini({ quotaBuckets: [
      { remainingFraction: 0.4, resetTime: '2023-11-14T22:14:00.000Z', modelId: 'gemini-pro' },
    ] }, NOW)
    expect(u.window5h?.used).toBe(60)
    expect(u.window5h?.limit).toBe(100)
    expect(typeof u.window5h?.resetAt).toBe('number')
    expect(u.label).toBe('Gemini')
  })
  it('tolerates empty buckets', () => {
    expect(normalizeGemini({ quotaBuckets: [] }, NOW).window5h).toBeUndefined()
  })
})

describe('readGeminiToken', () => {
  it('reads access_token', () => {
    const t = readGeminiToken({ home: '/h', readFile: (p) => { expect(p).toBe('/h/.gemini/oauth_creds.json'); return JSON.stringify({ access_token: 'GT' }) } })
    expect(t).toBe('GT')
  })
  it('throws when missing', () => {
    expect(() => readGeminiToken({ home: '/h', readFile: () => { throw new Error('ENOENT') } })).toThrow(/Gemini 未登录/)
  })
  it('throws generic error (no raw content) when file contains malformed JSON', () => {
    const fn = () => readGeminiToken({ home: '/h', readFile: () => 'not-json' })
    expect(fn).toThrow(/Gemini 未登录/)
    expect(fn).not.toThrow(/not-json/)
  })
})
