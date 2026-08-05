import { describe, it, expect } from 'vitest'
import { petJsonUrlFromSpritesheet, marketLocalId, CODEX_MARKET_ID_PREFIX } from './codexPetMarket'

describe('codexPetMarket helpers', () => {
  it('petJsonUrlFromSpritesheet swaps the last path segment (and query) for pet.json', () => {
    expect(petJsonUrlFromSpritesheet('https://codex-pets.net/assets/pets/v/123/nagato-yuki/spritesheet.webp'))
      .toBe('https://codex-pets.net/assets/pets/v/123/nagato-yuki/pet.json')
    // with a query string
    expect(petJsonUrlFromSpritesheet('https://x.net/a/b/spritesheet.webp?v=9'))
      .toBe('https://x.net/a/b/pet.json')
  })
  it('marketLocalId prefixes + sanitizes the site id (deterministic)', () => {
    expect(marketLocalId('nagato-yuki')).toBe(`${CODEX_MARKET_ID_PREFIX}nagato-yuki`)
    expect(marketLocalId('a/b..c')).toBe(`${CODEX_MARKET_ID_PREFIX}a_b_c`)
    expect(marketLocalId('x')).toBe(marketLocalId('x'))
  })
})
