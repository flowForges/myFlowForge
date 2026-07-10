import { describe, expect, it } from 'vitest'
import { BUILTIN_PET_IDS, builtinPetImagePath, builtinPets } from './builtinPets'

describe('pink catgirl built-in pet', () => {
  it('is included as the sixth built-in pet', () => {
    expect(BUILTIN_PET_IDS).toContain('pink-catgirl')
    expect(builtinPets().find(p => p.id === 'builtin-pink-catgirl')?.name).toBe('粉色猫娘')
  })

  it('uses animated webp while legacy built-ins retain static png paths', () => {
    expect(builtinPetImagePath('pink-catgirl', 'working')).toBe('builtin/pink-catgirl/webp/working.webp')
    expect(builtinPetImagePath('china-dragon', 'working')).toBe('builtin/china-dragon/png/working.png')
  })
})
