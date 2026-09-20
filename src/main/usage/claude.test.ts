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
  // Off macOS there is no Keychain, and Claude Code falls back to a plain file — per its own docs,
  // `%USERPROFILE%\.claude\.credentials.json` on Windows and `~/.claude/.credentials.json` (0600)
  // on Linux. Same JSON payload as the Keychain entry, so the same parser reads it.
  it('reads the credentials file on Windows', () => {
    const token = readClaudeToken({
      platform: 'win32',
      home: 'C:\\Users\\me',
      readCredFile: (p) => {
        expect(p).toBe('C:\\Users\\me\\.claude\\.credentials.json')
        return JSON.stringify({ claudeAiOauth: { accessToken: 'WT' } })
      },
    })
    expect(token).toBe('WT')
  })

  it('reads the credentials file on Linux', () => {
    const token = readClaudeToken({
      platform: 'linux',
      home: '/home/me',
      readCredFile: () => JSON.stringify({ claudeAiOauth: { accessToken: 'LT' } }),
    })
    expect(token).toBe('LT')
  })

  // Claude Code honours CLAUDE_CONFIG_DIR off macOS; the credentials file moves with it.
  it('honours CLAUDE_CONFIG_DIR', () => {
    let seen = ''
    readClaudeToken({
      platform: 'linux',
      home: '/home/me',
      env: { CLAUDE_CONFIG_DIR: '/opt/claude-cfg' },
      readCredFile: (p) => { seen = p; return JSON.stringify({ claudeAiOauth: { accessToken: 'X' } }) },
    })
    expect(seen).toBe('/opt/claude-cfg/.credentials.json')
  })

  it('never shells out to the macOS Keychain off macOS', () => {
    let calledSecurity = false
    expect(() => readClaudeToken({
      platform: 'win32',
      home: 'C:\\Users\\me',
      runSecurity: () => { calledSecurity = true; return '' },
      readCredFile: () => { throw new Error('ENOENT') },
    })).toThrow(/Claude 未登录/)
    expect(calledSecurity).toBe(false)
  })

  it('reports 未登录 (not a platform error) when the credentials file is absent', () => {
    expect(() => readClaudeToken({
      platform: 'win32', home: 'C:\\Users\\me', readCredFile: () => { throw new Error('ENOENT') },
    })).toThrow(/Claude 未登录/)
  })

  it('never leaks the file contents into the error when it is malformed', () => {
    const fn = () => readClaudeToken({ platform: 'win32', home: 'C:\\U', readCredFile: () => 'not-json' })
    expect(fn).toThrow(/Claude 未登录/)
    expect(fn).not.toThrow(/not-json/)
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
