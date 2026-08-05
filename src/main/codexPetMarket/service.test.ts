import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { codexMarketCatalog, codexMarketInstall, type MarketFetch } from './service'
import { marketLocalId } from '@shared/codexPetMarket'

// Fake proxy-fetch: routes by URL substring. arrayBuffer() returns 4 dummy bytes.
function fakeFetch(routes: Record<string, unknown>, opts: { missing?: string } = {}): MarketFetch {
  return async (url: string) => {
    if (opts.missing && url.includes(opts.missing)) return resp(404, null)
    const key = Object.keys(routes).find(k => url.includes(k))
    return resp(200, key ? routes[key] : null)
  }
  function resp(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/webp' : null) },
    }
  }
}

const samplePage = {
  page: 2, pageSize: 30, total: 2960, totalPages: 99,
  pets: [
    { id: 'yuki', displayName: 'Yuki', spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1/yuki/spritesheet.webp',
      previewUrl: 'https://codex-pets.net/assets/pets/v/1/yuki/preview.webp', ownerName: 'kira' },
    { id: 'noOwnerName', spritesheetUrl: 'https://x/y/z/spritesheet.webp', ownerHandle: 'h1' }, // fallbacks
    { displayName: 'invalid (no id/sheet)' }, // dropped
  ],
}

describe('codexMarketCatalog', () => {
  it('normalizes pets (derives petJsonUrl, falls back displayName/owner/preview) and keeps pagination', async () => {
    const res = await codexMarketCatalog(2, fakeFetch({ '/api/pets': samplePage }))
    expect('error' in res).toBe(false)
    if ('error' in res) return
    expect(res).toMatchObject({ page: 2, pageSize: 30, total: 2960, totalPages: 99 })
    expect(res.pets).toHaveLength(2) // invalid one dropped
    expect(res.pets[0]).toMatchObject({
      id: 'yuki', displayName: 'Yuki', ownerName: 'kira',
      petJsonUrl: 'https://codex-pets.net/assets/pets/v/1/yuki/pet.json',
    })
    // fallbacks: displayName←id, ownerName←ownerHandle, previewUrl←spritesheetUrl
    expect(res.pets[1]).toMatchObject({ displayName: 'noOwnerName', ownerName: 'h1', previewUrl: 'https://x/y/z/spritesheet.webp' })
  })
  it('returns an error on a non-ok list response', async () => {
    const res = await codexMarketCatalog(1, fakeFetch({}, { missing: '/api/pets' }))
    expect('error' in res).toBe(true)
  })
})

describe('codexMarketInstall', () => {
  const item = {
    id: 'yuki', displayName: 'Yuki',
    spritesheetUrl: 'https://codex-pets.net/a/yuki/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/a/yuki/preview.webp',
    petJsonUrl: 'https://codex-pets.net/a/yuki/pet.json',
    ownerName: 'kira',
  }

  it('downloads pet.json + spritesheet, writes the sheet, and returns a v2 atlas CustomPet', async () => {
    const base = mkdtempSync(join(tmpdir(), 'petmkt-'))
    const fetch = fakeFetch({
      'pet.json': { id: 'yuki', displayName: 'Yuki', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 2 },
      'spritesheet.webp': {},
    })
    const res = await codexMarketInstall(item, fetch, base)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const id = marketLocalId('yuki')
    expect(res.pet).toMatchObject({ id, name: 'Yuki', atlas: { path: `${id}/spritesheet.webp`, version: 2 } })
    expect(existsSync(join(base, id, 'spritesheet.webp'))).toBe(true)
    expect(readFileSync(join(base, id, 'spritesheet.webp')).length).toBe(4)
  })

  it('rejects a non-v2 / invalid pet.json without writing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'petmkt-'))
    const fetch = fakeFetch({ 'pet.json': { id: 'x', displayName: 'x', spritesheetPath: 's.webp', spriteVersionNumber: 1 }, 'spritesheet.webp': {} })
    const res = await codexMarketInstall(item, fetch, base)
    expect(res.ok).toBe(false)
  })
})
