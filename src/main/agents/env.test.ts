import { describe, it, expect } from 'vitest'
import { buildAgentEnv } from './env'

describe('buildAgentEnv', () => {
  it('injects proxy vars and merges provider overrides', () => {
    const env = buildAgentEnv({ proxy: 'http://127.0.0.1:7897', overrides: { FOO: 'bar' } })
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.ALL_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.FOO).toBe('bar')
  })
  it('omits proxy vars when proxy empty', () => {
    const env = buildAgentEnv({ proxy: '' })
    expect(env.HTTPS_PROXY).toBeUndefined()
  })
  it('injects env.TZ when a timezone is given', () => {
    const env = buildAgentEnv({ proxy: '', timezone: 'Asia/Shanghai' })
    expect(env.TZ).toBe('Asia/Shanghai')
  })
  it('leaves the inherited TZ untouched when timezone is empty/absent', () => {
    const saved = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      expect(buildAgentEnv({ proxy: '' }).TZ).toBe('America/New_York')
      expect(buildAgentEnv({ proxy: '', timezone: '  ' }).TZ).toBe('America/New_York')
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved
    }
  })
  it('strips an INHERITED proxy when proxy is empty so "直连" is literal', () => {
    // The app's launch env may already carry a proxy the user can't see/clear from the pane.
    // "留空则直连" must mean direct — not "silently reuse whatever HTTP_PROXY leaked in at launch".
    const saved = { ...process.env }
    try {
      process.env.HTTP_PROXY = 'http://stale:9999'
      process.env.HTTPS_PROXY = 'http://stale:9999'
      process.env.ALL_PROXY = 'http://stale:9999'
      const env = buildAgentEnv({ proxy: '' })
      expect(env.HTTP_PROXY).toBeUndefined()
      expect(env.HTTPS_PROXY).toBeUndefined()
      expect(env.ALL_PROXY).toBeUndefined()
      expect(env.http_proxy).toBeUndefined()
    } finally {
      process.env = saved
    }
  })
})
