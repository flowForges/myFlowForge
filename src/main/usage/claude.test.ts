import { describe, it, expect } from 'vitest'
import { normalizeClaude, readClaudeToken } from './claude'

const NOW = 1_700_000_000_000

describe('normalizeClaude', () => {
  it('maps five_hour→5h, seven_day→weekly', () => {
    const u = normalizeClaude({
      five_hour: { utilization: 20, resets_at: 1_700_003_600 },
      seven_day: { utilization: 55, resets_at: 1_700_600_000 },
    }, NOW)
    expect(u.window5h).toEqual({ used: 20, limit: 100, resetAt: 1_700_003_600_000 })
    expect(u.weekly).toEqual({ used: 55, limit: 100, resetAt: 1_700_600_000_000 })
    expect(u.label).toBe('Claude')
  })

  it('parses the real ISO-string resets_at the live /oauth/usage endpoint returns', () => {
    // Real response shape: utilization + ISO-8601 resets_at (was being dropped → no reset shown).
    const u = normalizeClaude({
      five_hour: { utilization: 33, resets_at: '2026-06-29T12:20:00.743228+00:00' },
      seven_day: { utilization: 45, resets_at: '2026-07-03T03:00:00.743254+00:00' },
    }, NOW)
    expect(u.window5h).toEqual({ used: 33, limit: 100, resetAt: Date.parse('2026-06-29T12:20:00.743228+00:00') })
    expect(u.weekly).toEqual({ used: 45, limit: 100, resetAt: Date.parse('2026-07-03T03:00:00.743254+00:00') })
  })
})

describe('readClaudeToken', () => {
  it('parses accessToken from keychain JSON on darwin', () => {
    const token = readClaudeToken({
      platform: 'darwin',
      runSecurity: () => JSON.stringify({ claudeAiOauth: { accessToken: 'CT' } }),
    })
    expect(token).toBe('CT')
  })
  it('throws on non-darwin', () => {
    expect(() => readClaudeToken({ platform: 'linux', runSecurity: () => '' })).toThrow(/macOS/)
  })
  it('throws when keychain empty', () => {
    expect(() => readClaudeToken({ platform: 'darwin', runSecurity: () => { throw new Error('not found') } })).toThrow(/Claude 未登录/)
  })
  it('throws generic error (no raw content) when keychain returns malformed JSON', () => {
    const fn = () => readClaudeToken({ platform: 'darwin', runSecurity: () => 'not-json' })
    expect(fn).toThrow(/Claude 未登录/)
    expect(fn).not.toThrow(/not-json/)
  })
})
