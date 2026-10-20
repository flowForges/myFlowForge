import { describe, it, expect } from 'vitest'
import { readCodexModelsCache, codexModelHasFastTier } from './codexModels'

const cache = JSON.stringify({
  fetched_at: 1, models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', description: '旗舰', visibility: 'list' },
    { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 mini', visibility: 'list' },
    { slug: 'internal-secret', display_name: 'Hidden', visibility: 'hidden' },
    { display_name: 'no-slug' },
  ],
})

describe('readCodexModelsCache', () => {
  it('maps slug/display_name/description from the local cache file', () => {
    const out = readCodexModelsCache({ home: '/h', readFile: () => cache })
    expect(out).toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5', description: '旗舰', fastTier: false },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', fastTier: false },
    ])
  })
  it('skips models whose visibility is not "list"', () => {
    const out = readCodexModelsCache({ home: '/h', readFile: () => cache })
    expect(out.some(m => m.id === 'internal-secret')).toBe(false)
  })
  it('fails open to [] when the file is missing', () => {
    expect(readCodexModelsCache({ home: '/h', readFile: () => { throw new Error('ENOENT') } })).toEqual([])
  })
  it('fails open to [] on malformed JSON', () => {
    expect(readCodexModelsCache({ home: '/h', readFile: () => 'not-json' })).toEqual([])
  })
})

// 真实 models_cache.json 的形状(codex 0.154):service_tiers 里列出 priority = 快速档。
const tiered = JSON.stringify({
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }] },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast' }] },
    { slug: 'plain', display_name: 'Plain', visibility: 'list', service_tiers: [] },
    { slug: 'other-tier', display_name: 'Other', visibility: 'list', service_tiers: [{ id: 'flex', name: 'Flex' }] },
    { slug: 'no-field', display_name: 'No field', visibility: 'list' },
  ],
})

describe('codex 快速档(service tier "priority")', () => {
  const read = () => readCodexModelsCache({ home: '/h', readFile: () => tiered })
  it('service_tiers 里有 priority → fastTier: true,并带上 codex 自己的描述', () => {
    expect(read().find(m => m.id === 'gpt-6-astra')).toMatchObject({ fastTier: true, fastTierDescription: '2x speed, increased usage' })
  })
  it('有 priority 但没描述 → fastTier: true,不编描述', () => {
    const m = read().find(m => m.id === 'gpt-5.6-sol')!
    expect(m.fastTier).toBe(true)
    expect(m.fastTierDescription).toBeUndefined()
  })
  it('空数组 / 只有别的档 / 没有这个字段 → fastTier: false', () => {
    const out = read()
    for (const id of ['plain', 'other-tier', 'no-field']) expect(out.find(m => m.id === id)!.fastTier).toBe(false)
  })
  it('codexModelHasFastTier 按模型查;default / 未知模型 / 读不到缓存都是 false', () => {
    const deps = { home: '/h', readFile: () => tiered }
    expect(codexModelHasFastTier('gpt-6-astra', deps)).toBe(true)
    expect(codexModelHasFastTier('plain', deps)).toBe(false)
    expect(codexModelHasFastTier('default', deps)).toBe(false)
    expect(codexModelHasFastTier('nope', deps)).toBe(false)
    expect(codexModelHasFastTier('gpt-6-astra', { home: '/h', readFile: () => { throw new Error('ENOENT') } })).toBe(false)
  })
})
