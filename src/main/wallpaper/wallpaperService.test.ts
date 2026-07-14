import { describe, it, expect } from 'vitest'
import { wallpaperCatalog, wallpaperPreview, wallpaperInstall, type WallpaperFetch } from './wallpaperService'
import type { WallpaperItem } from '../../shared/wallpaper'

function fakeFetch(handler: (url: string) => {
  ok: boolean; status: number; body?: unknown; bytes?: Uint8Array; ct?: string
}): WallpaperFetch {
  return async (url) => {
    const r = handler(url)
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer as ArrayBuffer,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (r.ct ?? 'image/jpeg') : null) },
    }
  }
}

const item: WallpaperItem = {
  id: 'fj01', cat: '风景游戏', name: 'A',
  url: 'https://cdn/bg/fj01.jpg', thumb: 'https://cdn/thumb/fj01.jpg', desc: 'd',
}

describe('wallpaperCatalog', () => {
  it('returns valid wallpapers', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { wallpapers: [item] } }))
    expect(await wallpaperCatalog(f)).toEqual({ wallpapers: [item] })
  })
  it('filters out entries missing required fields (id/url/name), keeps thumb-less ones', async () => {
    const noThumb = { id: 'cm09', cat: '纯美', name: 'B', url: 'u/cm09' } // valid even without thumb
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { wallpapers: [item, noThumb, { id: 'x' }, { name: 'no-url' }] } }))
    expect(await wallpaperCatalog(f)).toEqual({ wallpapers: [item, noThumb] })
  })
  it('malformed body → empty array', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { junk: 1 } }))
    expect(await wallpaperCatalog(f)).toEqual({ wallpapers: [] })
  })
  it('non-200 → error', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    expect(await wallpaperCatalog(f)).toEqual({ error: '获取壁纸目录失败(404)' })
  })
  it('network error → friendly message', async () => {
    const f: WallpaperFetch = async () => { throw new Error('net') }
    expect(await wallpaperCatalog(f)).toEqual({ error: '无法连接壁纸服务' })
  })
})

describe('wallpaper preview/install error paths (no file writes)', () => {
  it('preview 404 → error before writing', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    expect(await wallpaperPreview(item, f)).toEqual({ error: '下载失败(404)' })
  })
  it('preview derives /thumb/ from a /bg/ url when thumb is absent', async () => {
    const fetched: string[] = []
    const f = fakeFetch((url) => { fetched.push(url); return { ok: false, status: 404 } })
    await wallpaperPreview({ id: 'fj01', cat: '风景游戏', name: 'A', url: 'https://cdn/gh/x@v1/bg/fj01.jpg' }, f)
    expect(fetched).toEqual(['https://cdn/gh/x@v1/thumb/fj01.jpg'])
  })
  it('preview falls back to full url when no thumb and url has no /bg/ segment', async () => {
    const fetched: string[] = []
    const f = fakeFetch((url) => { fetched.push(url); return { ok: false, status: 404 } })
    await wallpaperPreview({ id: 'cm09', cat: '纯美', name: 'B', url: 'u/cm09' }, f)
    expect(fetched).toEqual(['u/cm09'])
  })
  it('install 404 → error before writing', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    expect(await wallpaperInstall(item, f)).toEqual({ error: '下载失败(404)' })
  })
})
