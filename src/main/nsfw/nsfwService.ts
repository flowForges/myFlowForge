import { NSFW_WORKER_URL, nsfwConfigured, type NsfwCatalog, type NsfwPet, type NsfwBg, type NsfwGallery } from '../../shared/nsfw'
import { writePetImageFromDataUrl } from '../pet/petImageStore'
import { storeBackgroundFromBytes, backgroundImageUrl } from '../appearance/backgroundStore'
import type { PreviewCache } from '../appearance/previewCache'

// License-gated extra content. The app holds only NSFW_WORKER_URL; the Worker validates the activation
// code and proxies image bytes. These functions take an injected fetch (proxy-aware in prod, faked in
// tests) so nothing here hits the network directly.
export type NsfwFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  headers: { get(name: string): string | null }
}>

const CT_EXT: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg' }
const EXT_MIME: Record<string, string> = { webp: 'image/webp', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg' }

// POST the code to /unlock; 200 = valid, 403 = wrong code.
export async function nsfwValidate(code: string, fetchImpl: NsfwFetch): Promise<{ ok: boolean; error?: string }> {
  if (!nsfwConfigured()) return { ok: false, error: '内容服务未配置' }
  if (!code.trim()) return { ok: false, error: '请输入激活码' }
  try {
    const res = await fetchImpl(`${NSFW_WORKER_URL}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) })
    if (res.ok) return { ok: true }
    return { ok: false, error: res.status === 403 ? '激活码无效' : `校验失败(${res.status})` }
  } catch { return { ok: false, error: '无法连接内容服务' } }
}

export async function nsfwCatalog(code: string, fetchImpl: NsfwFetch): Promise<NsfwCatalog | { error: string }> {
  if (!nsfwConfigured()) return { error: '内容服务未配置' }
  try {
    const res = await fetchImpl(`${NSFW_WORKER_URL}/catalog?key=${encodeURIComponent(code)}`)
    if (!res.ok) return { error: res.status === 403 ? '激活码已失效,请重新激活' : `获取目录失败(${res.status})` }
    const c = (await res.json()) as Partial<NsfwCatalog>
    return { pets: Array.isArray(c.pets) ? c.pets : [], backgrounds: Array.isArray(c.backgrounds) ? c.backgrounds : [] }
  } catch { return { error: '无法连接内容服务' } }
}

async function fetchImage(url: string, fetchImpl: NsfwFetch): Promise<{ buf: Buffer; ext: string } | { error: string }> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { error: `下载失败(${res.status})` }
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
    return { buf: Buffer.from(await res.arrayBuffer()), ext: CT_EXT[ct] || 'webp' }
  } catch { return { error: '下载失败' } }
}

// Download every listed state of a pet into pet-images under a caller-supplied local petId, returning
// the { name, images } shape PetPane already consumes. idle is required; other states are best-effort.
export async function nsfwInstallPet(
  petId: string,
  pet: NsfwPet,
  code: string,
  fetchImpl: NsfwFetch,
): Promise<{ name: string; images: Record<string, string> } | { error: string }> {
  if (!nsfwConfigured()) return { error: '内容服务未配置' }
  const states = pet.states?.length ? pet.states : ['idle']
  const images: Record<string, string> = {}
  for (const state of states) {
    const url = `${NSFW_WORKER_URL}/content/pet/${encodeURIComponent(pet.id)}/${encodeURIComponent(state)}?key=${encodeURIComponent(code)}`
    const r = await fetchImage(url, fetchImpl)
    if ('error' in r) {
      if (state === 'idle') return { error: `idle 图${r.error}` }
      continue // optional state missing → fall back to idle at render time
    }
    const dataUrl = `data:${EXT_MIME[r.ext] || 'image/webp'};base64,${r.buf.toString('base64')}`
    const rel = writePetImageFromDataUrl(petId, state, dataUrl)
    if (rel) images[state] = rel
  }
  if (!images.idle) return { error: '缺少 idle 图' }
  return { name: pet.name, images }
}

// Download an image (a pet's idle, or a background) for on-screen preview and cache it ON DISK, returning
// a forge-bg:// URL. The renderer holds only the small URL and streams the bytes from disk — the full
// image never sits in renderer memory as a data URL. Content-addressed, so a later install of the same
// image reuses this exact file (no re-download).
export async function nsfwPreview(kind: 'pet' | 'bg', id: string, code: string, fetchImpl: NsfwFetch, cache?: PreviewCache): Promise<{ url: string } | { error: string }> {
  if (!nsfwConfigured()) return { error: '内容服务未配置' }
  const path = kind === 'pet' ? `content/pet/${encodeURIComponent(id)}/idle` : `content/bg/${encodeURIComponent(id)}`
  // Cache key is the Worker PATH (no `?key=<code>` — never persist the activation code to disk). A hit
  // returns the already-downloaded thumbnail with zero network → no Cloudflare request on re-open.
  const cached = cache?.lookup(path)
  if (cached) return { url: backgroundImageUrl(cached) }
  const r = await fetchImage(`${NSFW_WORKER_URL}/${path}?key=${encodeURIComponent(code)}`, fetchImpl)
  if ('error' in r) return r
  const stored = storeBackgroundFromBytes(r.buf, r.ext)
  if ('error' in stored) return stored
  cache?.record(path, stored.rel)
  return { url: backgroundImageUrl(stored.rel) }
}

// The cache key nsfwPreview uses for an item — kept identical so a batch-fetched preview and a later
// single nsfwPreview() call resolve to the SAME cached file (and the same GC keep-set entry).
function previewPath(kind: 'pet' | 'bg', id: string): string {
  return kind === 'pet' ? `content/pet/${encodeURIComponent(id)}/idle` : `content/bg/${encodeURIComponent(id)}`
}

// A raw fetch that yields the real Response (with a streamable .body) — makeContentFetch returns exactly
// this. Distinct from NsfwFetch (the small json/arrayBuffer view the other calls use) because the gallery
// stream must read the response body incrementally.
export type RawFetch = (url: string, init?: RequestInit) => Promise<Response>

// Split "pet:<id>" / "bg:<id>" → { kind, id } for cache keying.
function splitCardKey(key: string): { kind: 'pet' | 'bg'; id: string } {
  const i = key.indexOf(':')
  return { kind: (key.slice(0, i) as 'pet' | 'bg'), id: key.slice(i + 1) }
}

// Parse ONE stream frame payload ([1 extLen][ext][2 keyLen][key][image bytes]) → store the image on disk,
// record it in the preview cache (same key nsfwPreview uses → durable + GC-kept), and hand back {key,url}.
export function parsePreviewFrame(payload: Buffer, cache?: PreviewCache): { key: string; url: string } | null {
  if (payload.length < 3) return null
  const extLen = payload[0]
  const ext = payload.subarray(1, 1 + extLen).toString('utf8')
  const keyLen = payload.readUInt16BE(1 + extLen)
  const keyStart = 1 + extLen + 2
  const key = payload.subarray(keyStart, keyStart + keyLen).toString('utf8')
  const img = payload.subarray(keyStart + keyLen)
  if (img.length === 0 || !key) return null
  const stored = storeBackgroundFromBytes(Buffer.from(img), ext || 'webp')
  if ('error' in stored) return null
  const { kind, id } = splitCardKey(key)
  cache?.record(previewPath(kind, id), stored.rel)
  return { key, url: backgroundImageUrl(stored.rel) }
}

// Read the streamed /previews response frame-by-frame; call onPreview() for each thumbnail as it lands.
// Length-prefixed frames ([4-byte BE frameLen][payload]) — accumulate chunks, emit whole frames.
async function streamMissing(code: string, keys: string[], rawFetch: RawFetch, cache: PreviewCache | undefined, onPreview: (key: string, url: string) => void): Promise<void> {
  let res: Response
  try { res = await rawFetch(`${NSFW_WORKER_URL}/previews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, keys }) }) }
  catch { return }
  if (!res.ok || !res.body) return
  const reader = res.body.getReader()
  let buf = Buffer.alloc(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buf = Buffer.concat([buf, Buffer.from(value)])
    for (;;) {
      if (buf.length < 4) break
      const flen = buf.readUInt32BE(0)
      if (buf.length < 4 + flen) break
      const out = parsePreviewFrame(buf.subarray(4, 4 + flen), cache)
      buf = buf.subarray(4 + flen)
      if (out) onPreview(out.key, out.url)
    }
    if (done) break
  }
}

// Gallery load (design E). Fetches the small /catalog (the token-bucket 限流 entry point), resolves every
// thumbnail already on disk (0 network → instant), and returns immediately with those. The STILL-MISSING
// thumbnails then stream in from the Worker one-by-one — each arrives via emit() so the pane fills them in
// progressively. force (刷新) re-streams everything. Returns rateLimited when /catalog is throttled (429).
export async function nsfwGallery(code: string, rawFetch: RawFetch, cache: PreviewCache | undefined, emit: (key: string, url: string) => void, opts?: { force?: boolean }): Promise<NsfwGallery | { error: string; rateLimited?: boolean }> {
  if (!nsfwConfigured()) return { error: '内容服务未配置' }
  let res: Response
  try { res = await rawFetch(`${NSFW_WORKER_URL}/catalog?key=${encodeURIComponent(code)}`) }
  catch { return { error: '无法连接内容服务' } }
  if (res.status === 429) return { error: '刷新太频繁,请稍后再试', rateLimited: true }
  if (!res.ok) return { error: res.status === 403 ? '激活码已失效,请重新激活' : `获取目录失败(${res.status})` }
  let cat: { pets?: NsfwPet[]; backgrounds?: NsfwBg[] }
  try { cat = (await res.json()) as typeof cat } catch { return { error: '目录解析失败' } }
  const pets = Array.isArray(cat.pets) ? cat.pets : []
  const backgrounds = Array.isArray(cat.backgrounds) ? cat.backgrounds : []
  // Cache-first: cached thumbnails resolve instantly; the rest are streamed.
  const previews: Record<string, string> = {}
  const missing: string[] = []
  const consider = (key: string, kind: 'pet' | 'bg', id: string) => {
    if (!opts?.force && cache) { const rel = cache.lookup(previewPath(kind, id)); if (rel) { previews[key] = backgroundImageUrl(rel); return } }
    missing.push(key)
  }
  for (const p of pets) consider('pet:' + p.id, 'pet', p.id)
  for (const b of backgrounds) consider('bg:' + b.id, 'bg', b.id)
  // Stream the missing ones in the background (detached): each lands via emit() as it's stored.
  if (missing.length) void streamMissing(code, missing, rawFetch, cache, emit).catch(() => { /* stream died — those thumbs just stay blank */ })
  return { pets, backgrounds, previews }
}

// Download a background and store it under ~/.myFlowForge/backgrounds, returning its forge-bg:// URL.
export async function nsfwInstallBg(bg: NsfwBg, code: string, fetchImpl: NsfwFetch): Promise<{ url: string } | { error: string }> {
  if (!nsfwConfigured()) return { error: '内容服务未配置' }
  const url = `${NSFW_WORKER_URL}/content/bg/${encodeURIComponent(bg.id)}?key=${encodeURIComponent(code)}`
  const r = await fetchImage(url, fetchImpl)
  if ('error' in r) return r
  const stored = storeBackgroundFromBytes(r.buf, r.ext)
  if ('error' in stored) return stored
  return { url: backgroundImageUrl(stored.rel) }
}
