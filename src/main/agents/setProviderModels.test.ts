import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setProviderModels } from './refreshModels'

vi.mock('../config/store', () => ({
  readAgentsConfig: vi.fn(),
  writeAgentsConfig: vi.fn(),
}))

import { readAgentsConfig, writeAgentsConfig } from '../config/store'

const mockedRead = vi.mocked(readAgentsConfig)
const mockedWrite = vi.mocked(writeAgentsConfig)

describe('setProviderModels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedRead.mockReturnValue({ providers: [], custom: [] })
  })

  it('pushes a new provider entry when id not in config', () => {
    const models = [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }]
    const NOW = 1_700_000_000_000

    const result = setProviderModels('claude', models, NOW)

    expect(result).toEqual(models)
    expect(mockedWrite).toHaveBeenCalledOnce()
    const written = mockedWrite.mock.calls[0][0]
    const entry = written.providers.find((c: { id: string }) => c.id === 'claude')
    expect(entry).toBeDefined()
    expect(entry!.modelsCache).toEqual(models)
    expect(entry!.modelsFetchedAt).toBe(NOW)
  })

  it('updates existing provider entry in-place', () => {
    const existing = {
      providers: [{ id: 'claude', binOverride: '/usr/bin/claude', env: {}, modelsCache: [], modelsFetchedAt: 0 }],
      custom: [],
    }
    mockedRead.mockReturnValue(existing)

    const models = [{ id: 'opus', label: 'opus' }]
    const NOW = 42000

    setProviderModels('claude', models, NOW)

    const written = mockedWrite.mock.calls[0][0]
    expect(written.providers).toHaveLength(1)
    expect(written.providers[0].binOverride).toBe('/usr/bin/claude')  // preserved
    expect(written.providers[0].modelsCache).toEqual(models)
    expect(written.providers[0].modelsFetchedAt).toBe(NOW)
  })

  it('saving empty list sets modelsFetchedAt to 0 (resets cache → fallback to catalog)', () => {
    const existing = {
      providers: [{ id: 'claude', binOverride: '', env: {}, modelsCache: [{ id: 'opus', label: 'opus' }], modelsFetchedAt: 9999 }],
      custom: [],
    }
    mockedRead.mockReturnValue(existing)

    const result = setProviderModels('claude', [], 1_234_567)

    expect(result).toEqual([])
    const written = mockedWrite.mock.calls[0][0]
    expect(written.providers[0].modelsCache).toEqual([])
    expect(written.providers[0].modelsFetchedAt).toBe(0)
  })

  it('returns the models array passed in', () => {
    const models = [{ id: 'haiku', label: 'haiku', description: 'fast' }]
    const result = setProviderModels('claude', models, 1000)
    expect(result).toBe(models)
  })

  it('does not touch other providers in the config', () => {
    const existing = {
      providers: [
        { id: 'codex', binOverride: '', env: {}, modelsCache: [{ id: 'gpt-5', label: 'gpt-5' }], modelsFetchedAt: 100 },
        { id: 'gemini', binOverride: '', env: {}, modelsCache: [], modelsFetchedAt: 0 },
      ],
      custom: [],
    }
    mockedRead.mockReturnValue(existing)

    setProviderModels('claude', [{ id: 'opus', label: 'opus' }], 999)

    const written = mockedWrite.mock.calls[0][0]
    // codex and gemini should be untouched; claude is new (pushed)
    const codexEntry = written.providers.find((c: { id: string }) => c.id === 'codex')
    expect(codexEntry!.modelsCache).toEqual([{ id: 'gpt-5', label: 'gpt-5' }])
    const claudeEntry = written.providers.find((c: { id: string }) => c.id === 'claude')
    expect(claudeEntry).toBeDefined()
  })
})
