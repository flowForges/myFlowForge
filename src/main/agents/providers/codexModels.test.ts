import { describe, it, expect } from 'vitest'
import { readCodexModelsCache } from './codexModels'

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
      { id: 'gpt-5.5', label: 'GPT-5.5', description: '旗舰' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
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
