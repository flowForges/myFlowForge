import { describe, it, expect, vi, beforeEach } from 'vitest'
import { refreshProviderModels } from './refreshModels'
import type { AgentProvider, AgentTask, AgentCallbacks } from './types'

// Mock the store module so we don't touch the filesystem
vi.mock('../config/store', () => ({
  readAgentsConfig: vi.fn(),
  writeAgentsConfig: vi.fn(),
}))

import { readAgentsConfig, writeAgentsConfig } from '../config/store'

const mockedRead = vi.mocked(readAgentsConfig)
const mockedWrite = vi.mocked(writeAgentsConfig)

function makeProvider(id: string, liveModels?: () => Promise<{ id: string; label: string }[]>): AgentProvider {
  return {
    id,
    displayName: id,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: !!liveModels },
    detect: async () => true,
    listModels: async () => [],
    listModelsLive: liveModels,
    run: (_task: AgentTask, _cb: AgentCallbacks) => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
  }
}

describe('refreshProviderModels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedRead.mockReturnValue({ providers: [], custom: [] })
  })

  it('returns error when provider has no listModelsLive', async () => {
    const p = makeProvider('noLive')   // no liveModels fn
    const result = await refreshProviderModels('noLive', { noLive: p }, {})
    expect(result.models).toHaveLength(0)
    expect(result.error).toBe('该 provider 不支持动态模型')
    expect(mockedWrite).not.toHaveBeenCalled()
  })

  it('writes modelsCache + modelsFetchedAt when listModelsLive returns non-empty', async () => {
    const live = [{ id: 'm1', label: 'Model 1' }, { id: 'm2', label: 'Model 2' }]
    const p = makeProvider('qoder', async () => live)
    const NOW = 1_700_000_000_000

    const result = await refreshProviderModels('qoder', { qoder: p }, {}, NOW)

    expect(result.models).toEqual(live)
    expect(result.error).toBeUndefined()

    expect(mockedWrite).toHaveBeenCalledOnce()
    const written = mockedWrite.mock.calls[0][0]
    const provCfg = written.providers.find((c: { id: string }) => c.id === 'qoder')
    expect(provCfg).toBeDefined()
    expect(provCfg!.modelsCache).toEqual(live)
    expect(provCfg!.modelsFetchedAt).toBe(NOW)
  })

  it('upserts existing provider entry (keeps other providers intact)', async () => {
    const existing = {
      providers: [{ id: 'qoder', binOverride: '', env: {}, modelsCache: [], modelsFetchedAt: 0 }],
      custom: [],
    }
    mockedRead.mockReturnValue(existing)

    const live = [{ id: 'new', label: 'New' }]
    const p = makeProvider('qoder', async () => live)
    const NOW = 9999

    await refreshProviderModels('qoder', { qoder: p }, {}, NOW)

    const written = mockedWrite.mock.calls[0][0]
    expect(written.providers).toHaveLength(1)
    expect(written.providers[0].modelsCache).toEqual(live)
    expect(written.providers[0].modelsFetchedAt).toBe(NOW)
  })

  it('keeps old cache and returns error when listModelsLive returns empty array', async () => {
    const oldCache = [{ id: 'old', label: 'Old Model' }]
    mockedRead.mockReturnValue({
      providers: [{ id: 'qoder', binOverride: '', env: {}, modelsCache: oldCache, modelsFetchedAt: 100 }],
      custom: [],
    })

    const p = makeProvider('qoder', async () => [])
    const result = await refreshProviderModels('qoder', { qoder: p }, {})

    expect(result.models).toEqual(oldCache)
    expect(result.error).toBe('刷新失败(空结果)')
    expect(mockedWrite).not.toHaveBeenCalled()
  })

  it('keeps old cache and returns error when listModelsLive throws', async () => {
    const oldCache = [{ id: 'cached', label: 'Cached' }]
    mockedRead.mockReturnValue({
      providers: [{ id: 'cursor', binOverride: '', env: {}, modelsCache: oldCache, modelsFetchedAt: 500 }],
      custom: [],
    })

    const p = makeProvider('cursor', async () => { throw new Error('network error') })
    const result = await refreshProviderModels('cursor', { cursor: p }, {})

    expect(result.models).toEqual(oldCache)
    expect(result.error).toBe('刷新失败(空结果)')
    expect(mockedWrite).not.toHaveBeenCalled()
  })

  it('returns empty models (no error on cache) when provider not in registry and live returns empty', async () => {
    // no existing cache entry
    mockedRead.mockReturnValue({ providers: [], custom: [] })

    const p = makeProvider('qoder', async () => [])
    const result = await refreshProviderModels('qoder', { qoder: p }, {})

    expect(result.models).toHaveLength(0)
    expect(result.error).toBe('刷新失败(空结果)')
    expect(mockedWrite).not.toHaveBeenCalled()
  })
})
