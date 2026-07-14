import { describe, it, expect } from 'vitest'
import { petSrc, builtinAssetUrl } from './petSrc'

describe('petSrc', () => {
  it('resolves the bundled built-in (white-catgirl) to a bundled asset url (not the forge-pet protocol)', () => {
    const url = petSrc('builtin/white-catgirl/webp/idle.webp')
    expect(url).toBeTruthy()
    expect(url).not.toContain('forge-pet://')
    // bundled asset (Vite emits into /assets/…webp) — the exact hash varies, so match the shape
    expect(url).toMatch(/idle.*\.webp/)
  })

  it('maps every white-catgirl state webp to a bundled asset', () => {
    for (const state of ['idle', 'working', 'confirm', 'input', 'done']) {
      const stored = `builtin/white-catgirl/webp/${state}.webp`
      expect(builtinAssetUrl(stored), state).toBeTruthy()
      expect(petSrc(stored), state).not.toContain('forge-pet://')
    }
  })

  it('non-bundled (downloadable) packs are not in the Vite glob → fall back to forge-pet://', () => {
    // china-dragon etc. moved to on-demand download; they are served from disk, not bundled.
    expect(builtinAssetUrl('builtin/china-dragon/webp/idle.webp')).toBeUndefined()
  })

  it('routes user-uploaded relative paths through the forge-pet protocol', () => {
    expect(petSrc('pet-123/idle.png')).toBe('forge-pet://img/pet-123/idle.png')
  })

  it('passes data URLs through unchanged and returns undefined for empty', () => {
    expect(petSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(petSrc(undefined)).toBeUndefined()
  })
})
