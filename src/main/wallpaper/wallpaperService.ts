import { WALLPAPER_CATALOG_URL, type WallpaperCatalog, type WallpaperItem } from '../../shared/wallpaper'
import { storeBackgroundFromBytes, backgroundImageUrl } from '../appearance/backgroundStore'

// Built-in wallpapers. Unlike NSFW content there is no activation code and no Worker — we fetch the public
// catalog + images straight from jsDelivr. The injected fetch is proxy-aware in prod and faked in tests,
// and is structurally identical to NsfwFetch so both can share the same makeProxyFetch instance.
export type WallpaperFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  headers: { get(name: string): string | null }
}>

const CT_EXT: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg' }

// A catalog entry is only usable if it carries the id/name/url the gallery + installer need. `thumb` is
// optional — if a (possibly stale/cached) catalog lacks it, the preview falls back to the full-res url.
function validItem(w: unknown): w is WallpaperItem {
  const o = w as Partial<WallpaperItem>
  return !!o && typeof o.id === 'string' && typeof o.url === 'string' && typeof o.name === 'string'
}

export async function wallpaperCatalog(fetchImpl: WallpaperFetch): Promise<WallpaperCatalog | { error: string }> {
  try {
    const res = await fetchImpl(WALLPAPER_CATALOG_URL)
    if (!res.ok) return { error: `获取壁纸目录失败(${res.status})` }
    const c = (await res.json()) as Partial<WallpaperCatalog>
    const wallpapers = Array.isArray(c.wallpapers) ? c.wallpapers.filter(validItem) : []
    return { wallpapers }
  } catch { return { error: '无法连接壁纸服务' } }
}

async function fetchImage(url: string, fetchImpl: WallpaperFetch): Promise<{ buf: Buffer; ext: string } | { error: string }> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { error: `下载失败(${res.status})` }
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
    return { buf: Buffer.from(await res.arrayBuffer()), ext: CT_EXT[ct] || 'jpg' }
  } catch { return { error: '下载失败' } }
}

// Download the small thumbnail for on-screen preview and cache it on disk → forge-bg:// URL. Content-
// addressed, so applying the same thumbnail (or the full image, if identical bytes) reuses the file.
export async function wallpaperPreview(item: WallpaperItem, fetchImpl: WallpaperFetch): Promise<{ url: string } | { error: string }> {
  // Prefer the catalog's thumb. If it's missing (e.g. a stale-cached catalog.json), derive the thumb path
  // from the full url by convention (…/bg/<id>.<ext> → …/thumb/<id>.<ext>); the thumb files are served
  // fresh even when catalog.json is cached. Falls back to the full url if neither yields a thumb.
  const derived = item.url.includes('/bg/') ? item.url.replace('/bg/', '/thumb/') : ''
  const r = await fetchImage(item.thumb || derived || item.url, fetchImpl)
  if ('error' in r) return r
  const stored = storeBackgroundFromBytes(r.buf, r.ext)
  if ('error' in stored) return stored
  return { url: backgroundImageUrl(stored.rel) }
}

// Download the full-resolution image and store it under ~/.myFlowForge/backgrounds → forge-bg:// URL,
// ready to be set as the app/chat background.
export async function wallpaperInstall(item: WallpaperItem, fetchImpl: WallpaperFetch): Promise<{ url: string } | { error: string }> {
  const r = await fetchImage(item.url, fetchImpl)
  if ('error' in r) return r
  const stored = storeBackgroundFromBytes(r.buf, r.ext)
  if ('error' in stored) return stored
  return { url: backgroundImageUrl(stored.rel) }
}
