import { describe, it, expect } from 'vitest'
import { petPackCatalog, petPackPreview, petPackInstall, type PetPackFetch } from './petPackService'
import type { PetPackItem } from '../../shared/petPack'

function fakeFetch(handler: (url: string) => {
  ok: boolean; status: number; body?: unknown; bytes?: Uint8Array; ct?: string
}): PetPackFetch {
  return async (url) => {
    const r = handler(url)
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer as ArrayBuffer,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (r.ct ?? 'image/webp') : null) },
    }
  }
}

const item: PetPackItem = {
  id: 'china-dragon', name: '中国龙', desc: 'd', states: ['idle', 'working'],
  base: 'https://cdn/china-dragon', thumb: 'https://cdn/china-dragon/idle.webp',
}

describe('petPackCatalog', () => {
  it('returns valid pets', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { pets: [item] } }))
    expect(await petPackCatalog(f)).toEqual({ pets: [item] })
  })
  it('filters entries missing required fields (id/name/base/thumb/states)', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { pets: [item, { id: 'x' }, { id: 'y', name: 'n', base: 'b', thumb: 't', states: [] }] } }))
    expect(await petPackCatalog(f)).toEqual({ pets: [item] })
  })
  it('malformed body → empty array', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { junk: 1 } }))
    expect(await petPackCatalog(f)).toEqual({ pets: [] })
  })
  it('non-200 → error', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    expect(await petPackCatalog(f)).toEqual({ error: '获取宠物目录失败(404)' })
  })
  it('network error → friendly message', async () => {
    const f: PetPackFetch = async () => { throw new Error('net') }
    expect(await petPackCatalog(f)).toEqual({ error: '无法连接宠物服务' })
  })
})

describe('petPack preview/install error paths (no file writes)', () => {
  it('preview 404 → error before writing', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    expect(await petPackPreview(item, f)).toEqual({ error: '下载失败(404)' })
  })
  it('install: idle frame 404 → error before writing', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    const r = await petPackInstall('pack-china-dragon', item, f)
    expect('error' in r).toBe(true)
  })
  it('install fetches per-state webp from base', async () => {
    const fetched: string[] = []
    const f = fakeFetch((url) => { fetched.push(url); return { ok: false, status: 404 } })
    await petPackInstall('pack-china-dragon', item, f)
    expect(fetched[0]).toBe('https://cdn/china-dragon/idle.webp')
  })
})
