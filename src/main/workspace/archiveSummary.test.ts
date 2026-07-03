import { describe, it, expect } from 'vitest'
import { buildArchiveSummary } from './archiveSummary'

const base = { recentText: () => '用户在重构限流中间件', fallbackTitle: () => '限流排查' }

describe('buildArchiveSummary', () => {
  it('uses summarize result when available', async () => {
    const out = await buildArchiveSummary('/w', { ...base, summarize: async () => '  重构 API 网关限流配置  ' })
    expect(out).toBe('重构 API 网关限流配置')
  })
  it('falls back to title when no provider', async () => {
    const out = await buildArchiveSummary('/w', { ...base, summarize: null })
    expect(out).toBe('限流排查')
  })
  it('falls back on error', async () => {
    const out = await buildArchiveSummary('/w', { ...base, summarize: async () => { throw new Error('x') } })
    expect(out).toBe('限流排查')
  })
  it('falls back to title when body empty', async () => {
    const out = await buildArchiveSummary('/w', { recentText: () => '   ', fallbackTitle: () => 'T', summarize: async () => 'ignored' })
    expect(out).toBe('T')
  })
})
