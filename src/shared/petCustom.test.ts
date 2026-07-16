import { describe, it, expect } from 'vitest'
import { resolveActiveCustomPet, addCustomPet, removeCustomPet, PET_CUSTOM_MAX, type CustomPet } from './petCustom'

const emojiPet = (id: string, emoji = '🐱'): CustomPet => ({ id, name: `p${id}`, emoji, color: 'red' })

describe('resolveActiveCustomPet', () => {
  it('picks the entry matching activeCustomPetId', () => {
    const pets = [emojiPet('a', '🐱'), emojiPet('b', '🐶')]
    const r = resolveActiveCustomPet({ customPets: pets, activeCustomPetId: 'b' })
    expect(r.emoji?.emoji).toBe('🐶')
  })

  it('falls back to the first entry when activeCustomPetId is missing/unknown', () => {
    const pets = [emojiPet('a', '🐱'), emojiPet('b', '🐶')]
    expect(resolveActiveCustomPet({ customPets: pets }).emoji?.emoji).toBe('🐱')
    expect(resolveActiveCustomPet({ customPets: pets, activeCustomPetId: 'zzz' }).emoji?.emoji).toBe('🐱')
  })

  it('exposes an image-pack entry as images (no emoji)', () => {
    const pets: CustomPet[] = [{ id: 'x', name: 'pack', images: { idle: 'data:idle', working: 'data:working' } }]
    const r = resolveActiveCustomPet({ customPets: pets, activeCustomPetId: 'x' })
    expect(r.images.idle).toBe('data:idle')
    expect(r.emoji).toBeUndefined()
  })

  it('falls back to legacy singular fields when customPets is empty', () => {
    const r = resolveActiveCustomPet({
      customPets: [],
      customImages: { idle: 'legacy-idle' },
      customEmoji: { name: 'old', emoji: '👻', color: 'blue' },
    })
    expect(r.images.idle).toBe('legacy-idle')
    expect(r.emoji?.emoji).toBe('👻')
  })

  it('empty everything → empty images, no emoji', () => {
    const r = resolveActiveCustomPet({})
    expect(r.images).toEqual({})
    expect(r.emoji).toBeUndefined()
  })

  it('returns the active pet atlas when present', () => {
    const r = resolveActiveCustomPet({
      customPets: [{ id: 'p1', name: 'Doll', atlas: { path: 'p1/spritesheet.webp', version: 2 } }],
      activeCustomPetId: 'p1',
    })
    expect(r.atlas).toEqual({ path: 'p1/spritesheet.webp', version: 2 })
    expect(r.images).toEqual({})
  })

  it('has no atlas for an image-only pet', () => {
    const r = resolveActiveCustomPet({
      customPets: [{ id: 'p2', name: 'Cat', images: { idle: 'p2/idle.webp' } }],
      activeCustomPetId: 'p2',
    })
    expect(r.atlas).toBeUndefined()
  })
})

describe('addCustomPet', () => {
  it('appends up to the cap and refuses beyond it', () => {
    let list: CustomPet[] = []
    for (let i = 0; i < PET_CUSTOM_MAX; i++) list = addCustomPet(list, emojiPet(`p${i}`))
    expect(list).toHaveLength(PET_CUSTOM_MAX)
    const full = addCustomPet(list, emojiPet('overflow'))
    expect(full).toHaveLength(PET_CUSTOM_MAX)          // unchanged
    expect(full.some(p => p.id === 'overflow')).toBe(false)
  })

  it('cap allows six bundled pets plus ten user additions', () => { expect(PET_CUSTOM_MAX).toBe(16) })
})

describe('removeCustomPet', () => {
  it('removes by id and leaves the rest in order', () => {
    const list = [emojiPet('a'), emojiPet('b'), emojiPet('c')]
    expect(removeCustomPet(list, 'b').map(p => p.id)).toEqual(['a', 'c'])
  })
})
