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
      previewUrl: 'https://codex-pets.net/assets/pets/v/1/yuki/preview.webp',
      posterUrl: 'https://codex-pets.net/assets/pets/v/1/yuki/poster.webp', ownerName: 'kira' },
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
    // thumbnail prefers poster (single square) over preview (multi-frame filmstrip)
    expect(res.pets[0].previewUrl).toContain('poster.webp')
    // fallbacks: displayName←id, ownerName←ownerHandle, previewUrl←spritesheetUrl
    expect(res.pets[1]).toMatchObject({ displayName: 'noOwnerName', ownerName: 'h1', previewUrl: 'https://x/y/z/spritesheet.webp' })
  })
  it('returns an error on a non-ok list response', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'petmkt-cache-'))
    const res = await codexMarketCatalog(1, fakeFetch({}, { missing: '/api/pets' }), cache)
    expect('error' in res).toBe(true)
    if ('error' in res) expect(res.error).toContain('HTTP 404')
  })

  // codex-pets.net 是个第三方社区小站,慢/挂是常态。以前任何失败都塌成「无法连接 codex-pets.net」一句,
  // 用户既不知道该修什么,页面也是一片空白。
  describe('失败时的降级', () => {
    const netFail = (err: Error): MarketFetch => async () => { throw err }

    it('把网络错误分类成能照做的提示,而不是笼统一句', async () => {
      const cache = mkdtempSync(join(tmpdir(), 'petmkt-cache-'))
      const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
      const res = await codexMarketCatalog(1, netFail(timeout), cache)
      expect('error' in res).toBe(true)
      if ('error' in res) expect(res.error).toContain('超时')

      const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
      const res2 = await codexMarketCatalog(1, netFail(dns), cache)
      if ('error' in res2) expect(res2.error).toContain('域名解析失败')
    })

    it('429 单独成句(是被限流,不是断网)', async () => {
      const cache = mkdtempSync(join(tmpdir(), 'petmkt-cache-'))
      const limited: MarketFetch = async () => ({
        ok: false, status: 429, json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null },
      })
      const res = await codexMarketCatalog(1, limited, cache)
      if ('error' in res) expect(res.error).toContain('429')
    })

    it('成功结果落盘;下次连不上就拿它顶上并标记 stale', async () => {
      const cache = mkdtempSync(join(tmpdir(), 'petmkt-cache-'))
      const ok = await codexMarketCatalog(2, fakeFetch({ '/api/pets': samplePage }), cache)
      expect('error' in ok).toBe(false)
      expect(existsSync(join(cache, 'catalog-p2.json'))).toBe(true)

      const down = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      const res = await codexMarketCatalog(2, netFail(down), cache)
      expect('error' in res).toBe(false)
      if ('error' in res) return
      expect(res.stale).toBe(true)
      expect(res.staleReason).toContain('连接被拒绝')
      expect(res.pets).toHaveLength(2)   // 缓存里的内容照常可浏览
    })

    it('没有缓存时才真的报错', async () => {
      const cache = mkdtempSync(join(tmpdir(), 'petmkt-cache-'))
      const down = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      const res = await codexMarketCatalog(7, netFail(down), cache)
      expect('error' in res).toBe(true)
    })

    it('空结果不覆盖已有缓存(站点临时抽风不该抹掉好数据)', async () => {
      const cache = mkdtempSync(join(tmpdir(), 'petmkt-cache-'))
      await codexMarketCatalog(2, fakeFetch({ '/api/pets': samplePage }), cache)
      await codexMarketCatalog(2, fakeFetch({ '/api/pets': { page: 2, pets: [] } }), cache)
      const kept = JSON.parse(readFileSync(join(cache, 'catalog-p2.json'), 'utf8'))
      expect(kept.pets).toHaveLength(2)
    })
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
