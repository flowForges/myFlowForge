import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseImageDataUrl,
  petImageRelPath,
  writePetImageFromDataUrl,
  resolvePetImageAbs,
  migratePetImagesInPet,
  isDataUrl,
} from './petImageStore'
import type { Pet } from '../config/schema'

// A 1x1 PNG data URL.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'petimg-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('parseImageDataUrl', () => {
  it('decodes a base64 png data URL into mime/ext/bytes', () => {
    const p = parseImageDataUrl(PNG)
    expect(p?.mime).toBe('image/png')
    expect(p?.ext).toBe('png')
    expect(p?.buffer.length).toBeGreaterThan(0)
  })
  it('maps svg mime to the svg extension', () => {
    const p = parseImageDataUrl('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'))
    expect(p?.ext).toBe('svg')
  })
  it('returns null for unsupported / non-data-url input', () => {
    expect(parseImageDataUrl('data:application/pdf;base64,AAAA')).toBeNull()
    expect(parseImageDataUrl('not-a-data-url')).toBeNull()
  })
})

describe('isDataUrl', () => {
  it('detects data URLs and rejects plain paths', () => {
    expect(isDataUrl(PNG)).toBe(true)
    expect(isDataUrl('petX/idle.png')).toBe(false)
    expect(isDataUrl(undefined)).toBe(false)
  })
})

describe('writePetImageFromDataUrl', () => {
  it('writes the file and returns "<petId>/<state>.<ext>"', () => {
    const rel = writePetImageFromDataUrl('pet1', 'idle', PNG, dir)
    expect(rel).toBe(petImageRelPath('pet1', 'idle', 'png'))
    expect(existsSync(join(dir, rel!))).toBe(true)
    expect(readFileSync(join(dir, rel!)).length).toBeGreaterThan(0)
  })
  it('removes a stale sibling of another extension for the same state', () => {
    // pre-seed idle.gif; writing idle.png must delete idle.gif so the fallback chain can't pick it.
    mkdirSync(join(dir, 'pet1'), { recursive: true })
    writeFileSync(join(dir, 'pet1', 'idle.gif'), 'x')
    writePetImageFromDataUrl('pet1', 'idle', PNG, dir)
    expect(existsSync(join(dir, 'pet1', 'idle.gif'))).toBe(false)
    expect(existsSync(join(dir, 'pet1', 'idle.png'))).toBe(true)
  })
  it('returns null (writes nothing) for an unsupported data URL', () => {
    expect(writePetImageFromDataUrl('pet1', 'idle', 'data:text/plain,hi', dir)).toBeNull()
  })
  it('sanitizes unsafe id segments', () => {
    const rel = writePetImageFromDataUrl('../evil', 'idle', PNG, dir)
    expect(rel).not.toContain('..')
    expect(existsSync(join(dir, rel!))).toBe(true)
  })
})

describe('resolvePetImageAbs', () => {
  it('resolves a valid relative path inside the base dir', () => {
    expect(resolvePetImageAbs('pet1/idle.png', dir)).toBe(join(dir, 'pet1', 'idle.png'))
  })
  it('rejects path traversal that escapes the base dir', () => {
    expect(resolvePetImageAbs('../../etc/passwd', dir)).toBeNull()
  })
})

describe('migratePetImagesInPet', () => {
  const basePet = (over: Partial<Pet>): Pet => ({
    enabled: true, skin: 'custom', customPets: [], corner: 'right', pos: { bottom: 24 },
    followCursor: false, scale: 1, notify: { confirm: true, input: true, done: false },
    states: {
      idle: { anim: 'float', accent: 'none' }, working: { anim: 'float', accent: 'none' },
      confirm: { anim: 'float', accent: 'none' }, input: { anim: 'float', accent: 'none' },
      done: { anim: 'float', accent: 'none' },
    },
    ...over,
  }) as Pet

  it('converts inline data URLs in customPets to on-disk relative paths and counts them', () => {
    const pet = basePet({ customPets: [{ id: 'p1', name: 'a', images: { idle: PNG, working: PNG } }] })
    const { pet: out, migrated } = migratePetImagesInPet(pet, dir)
    expect(migrated).toBe(2)
    expect(out.customPets[0].images).toEqual({ idle: 'p1/idle.png', working: 'p1/working.png' })
    expect(existsSync(join(dir, 'p1', 'idle.png'))).toBe(true)
  })
  it('leaves already-migrated relative paths untouched (idempotent)', () => {
    const pet = basePet({ customPets: [{ id: 'p1', name: 'a', images: { idle: 'p1/idle.png' } }] })
    const { migrated, pet: out } = migratePetImagesInPet(pet, dir)
    expect(migrated).toBe(0)
    expect(out.customPets[0].images).toEqual({ idle: 'p1/idle.png' })
  })
  it('also migrates the legacy singular customImages field', () => {
    const pet = basePet({ customImages: { idle: PNG } })
    const { pet: out, migrated } = migratePetImagesInPet(pet, dir)
    expect(migrated).toBe(1)
    expect(out.customImages).toEqual({ idle: 'legacy/idle.png' })
  })
})
