import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCodexPetPack, discoverCodexPets } from './codexPetImport'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codexpet-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function makePack(dir: string, id = 'hkdoll') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({ id, displayName: `${id} 3D`, spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' }))
  writeFileSync(join(dir, 'spritesheet.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]))
}

describe('importCodexPetPack', () => {
  it('copies the spritesheet into the store and returns an atlas CustomPet', () => {
    const src = join(root, 'src-pack'); makePack(src, 'hkdoll')
    const store = join(root, 'store')
    const r = importCodexPetPack(src, store)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pet).toMatchObject({ id: 'hkdoll', name: 'hkdoll 3D', atlas: { path: 'hkdoll/spritesheet.webp', version: 2 } })
    expect(existsSync(join(store, 'hkdoll', 'spritesheet.webp'))).toBe(true)
  })

  it('rejects a pack whose manifest is not v2', () => {
    const src = join(root, 'bad'); mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'pet.json'), JSON.stringify({ id: 'x', displayName: 'X', spriteVersionNumber: 1, spritesheetPath: 'spritesheet.webp' }))
    expect(importCodexPetPack(src, join(root, 'store')).ok).toBe(false)
  })

  it('rejects when the spritesheet file is missing', () => {
    const src = join(root, 'nosheet'); mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'pet.json'), JSON.stringify({ id: 'x', displayName: 'X', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' }))
    expect(importCodexPetPack(src, join(root, 'store')).ok).toBe(false)
  })
})

describe('discoverCodexPets', () => {
  it('lists valid v2 packs under <codexHome>/pets/*', () => {
    makePack(join(root, 'pets', 'hkdoll'), 'hkdoll')
    makePack(join(root, 'pets', 'other'), 'other')
    const found = discoverCodexPets(root)
    expect(found.map(p => p.id).sort()).toEqual(['hkdoll', 'other'])
    expect(found[0].dir).toContain(join('pets'))
  })
  it('returns [] when there is no pets dir', () => {
    expect(discoverCodexPets(join(root, 'empty'))).toEqual([])
  })
})
