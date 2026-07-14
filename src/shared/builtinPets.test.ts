import { describe, expect, it } from 'vitest'
import { BUILTIN_PET_IDS, builtinPetImagePath, builtinPets } from './builtinPets'

describe('animated built-in pets', () => {
  it('ships only white-catgirl bundled (others are downloadable pet packs)', () => {
    expect(BUILTIN_PET_IDS).toEqual(['white-catgirl'])
    expect(builtinPets().find(p => p.id === 'builtin-white-catgirl')?.name).toBe('成年白系猫娘')
  })

  it('uses animated webp for every built-in pet', () => {
    for (const id of BUILTIN_PET_IDS) {
      expect(builtinPetImagePath(id, 'working')).toBe(`builtin/${id}/webp/working.webp`)
    }
  })
})
