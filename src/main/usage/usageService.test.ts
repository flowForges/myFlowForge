import { describe, it, expect } from 'vitest'
import { isNativeUsage, runUsagePlugin } from './usageService'
import type { InstalledPlugin } from '../plugins/pluginSchema'

const base: InstalledPlugin = { id: 'forge-official-codex-usage', dir: '', type: 'statusbar-usage', provider: 'codex', name: 'Codex', entry: 'native', refreshSec: 300, enabled: true, native: true }

describe('isNativeUsage', () => {
  it('true for native statusbar-usage', () => { expect(isNativeUsage(base)).toBe(true) })
  it('false when native flag absent', () => { expect(isNativeUsage({ ...base, native: false })).toBe(false) })
})

describe('runUsagePlugin', () => {
  it('returns ok with adapter data', async () => {
    const r = await runUsagePlugin(base, { fetchers: { codex: async () => ({ window5h: { used: 1, limit: 2 }, label: 'Codex' }) } })
    expect(r).toEqual({ ok: true, type: 'statusbar-usage', data: { window5h: { used: 1, limit: 2 }, label: 'Codex' } })
  })
  it('returns sanitized error on throw (no token leakage)', async () => {
    const r = await runUsagePlugin(base, { fetchers: { codex: async () => { throw new Error('boom Bearer sk-SECRET') } } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).not.toMatch(/SECRET/)
      expect(r.error).not.toMatch(/Bearer/)
    }
  })
  it('redacts bare long token (no Bearer prefix) in error message', async () => {
    const r = await runUsagePlugin(base, {
      fetchers: {
        codex: async () => {
          throw new Error('failed for token abcdefghijklmnopqrstuvwxyz0123456789ABCDEF')
        },
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).not.toMatch(/abcdefghijklmnopqrstuvwxyz/)
    }
  })
  it('errors for unknown provider', async () => {
    const r = await runUsagePlugin({ ...base, provider: 'nope' }, { fetchers: {} })
    expect(r.ok).toBe(false)
  })
  it('maps HTTP 403 to a re-login hint', async () => {
    const r = await runUsagePlugin(base, { fetchers: { codex: async () => { throw new Error('HTTP 403') } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/重新登录/)
  })
  it('maps fetch failed to a proxy/network hint', async () => {
    const r = await runUsagePlugin(base, { fetchers: { codex: async () => { throw new Error('fetch failed') } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/代理|网络/)
  })
})
