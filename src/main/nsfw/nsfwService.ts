import { NSFW_WORKER_URL, nsfwConfigured, type NsfwCatalog, type NsfwPet, type NsfwBg } from '../../shared/nsfw'
import { writePetImageFromDataUrl } from '../pet/petImageStore'
import { storeBackgroundFromBytes, backgroundImageUrl } from '../appearance/backgroundStore'

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
export async function nsfwPreview(kind: 'pet' | 'bg', id: string, code: string, fetchImpl: NsfwFetch): Promise<{ url: string } | { error: string }> {
  if (!nsfwConfigured()) return { error: '内容服务未配置' }
  const path = kind === 'pet' ? `content/pet/${encodeURIComponent(id)}/idle` : `content/bg/${encodeURIComponent(id)}`
  const r = await fetchImage(`${NSFW_WORKER_URL}/${path}?key=${encodeURIComponent(code)}`, fetchImpl)
  if ('error' in r) return r
  const stored = storeBackgroundFromBytes(r.buf, r.ext)
  if ('error' in stored) return stored
  return { url: backgroundImageUrl(stored.rel) }
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
