import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderInfo } from '@shared/types'

// Mock the underlying detector so no real CLI probing happens
vi.mock('./detect', () => ({ detectProviders: vi.fn() }))

import { detectProviders } from './detect'
import { cachedDetectProviders, invalidateDetectCache, DETECT_CACHE_TTL_MS } from './detectCache'

const mockedDetect = vi.mocked(detectProviders)

const info = (id: string): ProviderInfo =>
  ({ id, displayName: id, installed: true, models: [], bin: id, binPath: `/bin/${id}`, custom: false })

const REG = {}
const ENV = process.env

beforeEach(() => {
  vi.clearAllMocks()
  invalidateDetectCache()
  mockedDetect.mockResolvedValue([info('claude')])
})

describe('cachedDetectProviders — in-flight dedup', () => {
  it('shares a single in-flight probe across concurrent callers', async () => {
    let resolveDetect!: (v: ProviderInfo[]) => void
    mockedDetect.mockReturnValue(new Promise<ProviderInfo[]>(res => { resolveDetect = res }))

    const p1 = cachedDetectProviders(REG, ENV)
    const p2 = cachedDetectProviders(REG, ENV)
    expect(mockedDetect).toHaveBeenCalledTimes(1)

    resolveDetect([info('codex')])
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual([info('codex')])
    expect(r2).toEqual([info('codex')])
  })
})

describe('cachedDetectProviders — TTL', () => {
  it('serves the cached result within the TTL without re-probing', async () => {
    const t0 = 1_000_000
    await cachedDetectProviders(REG, ENV, { nowMs: t0 })
    const again = await cachedDetectProviders(REG, ENV, { nowMs: t0 + DETECT_CACHE_TTL_MS - 1 })
    expect(mockedDetect).toHaveBeenCalledTimes(1)
    expect(again).toEqual([info('claude')])
  })

  it('re-probes after the TTL expires', async () => {
    const t0 = 1_000_000
    await cachedDetectProviders(REG, ENV, { nowMs: t0 })
    mockedDetect.mockResolvedValue([info('gemini')])
    const later = await cachedDetectProviders(REG, ENV, { nowMs: t0 + DETECT_CACHE_TTL_MS + 1 })
    expect(mockedDetect).toHaveBeenCalledTimes(2)
    expect(later).toEqual([info('gemini')])
  })
})

describe('cachedDetectProviders — force', () => {
  it('force=true bypasses a fresh cache and re-probes', async () => {
    const t0 = 1_000_000
    await cachedDetectProviders(REG, ENV, { nowMs: t0 })
    mockedDetect.mockResolvedValue([info('qoder')])
    const forced = await cachedDetectProviders(REG, ENV, { nowMs: t0 + 1, force: true })
    expect(mockedDetect).toHaveBeenCalledTimes(2)
    expect(forced).toEqual([info('qoder')])
  })

  it('a forced probe refills the cache for subsequent callers', async () => {
    const t0 = 1_000_000
    await cachedDetectProviders(REG, ENV, { nowMs: t0 })
    mockedDetect.mockResolvedValue([info('cursor')])
    await cachedDetectProviders(REG, ENV, { nowMs: t0 + 1, force: true })
    const cached = await cachedDetectProviders(REG, ENV, { nowMs: t0 + 2 })
    expect(mockedDetect).toHaveBeenCalledTimes(2)   // forced call filled the cache
    expect(cached).toEqual([info('cursor')])
  })
})

describe('cachedDetectProviders — invalidation & errors', () => {
  it('invalidateDetectCache() drops the cache so the next call re-probes', async () => {
    await cachedDetectProviders(REG, ENV, { nowMs: 1_000 })
    invalidateDetectCache()
    await cachedDetectProviders(REG, ENV, { nowMs: 1_001 })
    expect(mockedDetect).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed probe — the next call retries', async () => {
    mockedDetect.mockRejectedValueOnce(new Error('boom'))
    await expect(cachedDetectProviders(REG, ENV, { nowMs: 1_000 })).rejects.toThrow('boom')
    const ok = await cachedDetectProviders(REG, ENV, { nowMs: 1_001 })
    expect(mockedDetect).toHaveBeenCalledTimes(2)
    expect(ok).toEqual([info('claude')])
  })
})
