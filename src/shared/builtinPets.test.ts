import { describe, expect, it } from 'vitest'
import { BUILTIN_PET_IDS, builtinPetImagePath, builtinPets } from './builtinPets'

describe('animated built-in pets', () => {
  it('is included as the sixth built-in pet', () => {
    expect(BUILTIN_PET_IDS).toContain('pink-catgirl')
    expect(builtinPets().find(p => p.id === 'builtin-pink-catgirl')?.name).toBe('粉色猫娘')
  })

  it('uses animated webp for every built-in pet', () => {
    for (const id of BUILTIN_PET_IDS) {
      expect(builtinPetImagePath(id, 'working')).toBe(`builtin/${id}/webp/working.webp`)
    }
  })
})
