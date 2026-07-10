import { describe, it, expect } from 'vitest'
import { petSrc, builtinAssetUrl } from './petSrc'

describe('petSrc', () => {
  it('resolves built-in pack paths to a bundled asset url (not the forge-pet protocol)', () => {
    const url = petSrc('builtin/china-dragon/png/idle.png')
    expect(url).toBeTruthy()
    expect(url).not.toContain('forge-pet://')
    // bundled asset (Vite emits into /assets/…png) — the exact hash varies, so match the shape
    expect(url).toMatch(/idle.*\.png/)
  })

  it('maps every built-in pet/state to a bundled asset', () => {
    for (const id of ['china-dragon', 'white-catgirl', 'rocket-fox', 'phoenix', 'cyber-jellyfish']) {
      for (const state of ['idle', 'working', 'confirm', 'input', 'done']) {
        expect(builtinAssetUrl(`builtin/${id}/png/${state}.png`), `${id}/${state}`).toBeTruthy()
      }
    }
  })

  it('bundles the pink catgirl animated webp states', () => {
    for (const state of ['idle', 'working', 'confirm', 'input', 'done']) {
      const stored = `builtin/pink-catgirl/webp/${state}.webp`
      expect(builtinAssetUrl(stored), state).toBeTruthy()
      expect(petSrc(stored), state).not.toContain('forge-pet://')
    }
  })

  it('routes user-uploaded relative paths through the forge-pet protocol', () => {
    expect(petSrc('pet-123/idle.png')).toBe('forge-pet://img/pet-123/idle.png')
  })

  it('passes data URLs through unchanged and returns undefined for empty', () => {
    expect(petSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(petSrc(undefined)).toBeUndefined()
  })
})
