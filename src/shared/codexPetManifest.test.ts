import { describe, it, expect } from 'vitest'
import { parseCodexManifest } from './codexPetManifest'

const valid = { id: 'hkdoll', displayName: 'HK Doll', description: 'x', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' }

describe('parseCodexManifest', () => {
  it('accepts a valid v2 manifest', () => {
    const r = parseCodexManifest(valid)
    expect(r).toEqual({ ok: true, manifest: valid })
  })
  it('rejects a non-v2 sprite version', () => {
    const r = parseCodexManifest({ ...valid, spriteVersionNumber: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/spriteVersionNumber/)
  })
  it('rejects missing required fields', () => {
    expect(parseCodexManifest({ id: 'x' }).ok).toBe(false)
    expect(parseCodexManifest(null).ok).toBe(false)
    expect(parseCodexManifest('nope').ok).toBe(false)
  })
  it('requires spritesheetPath (no fallback)', () => {
    const { spritesheetPath, ...noSheet } = valid
    void spritesheetPath
    expect(parseCodexManifest(noSheet).ok).toBe(false)
  })
})
