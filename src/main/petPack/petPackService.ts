import { PET_PACK_CATALOG_URL, type PetPackCatalog, type PetPackItem } from '../../shared/petPack'
import { writePetImageFromDataUrl } from '../pet/petImageStore'
import { storeBackgroundFromBytes, backgroundImageUrl } from '../appearance/backgroundStore'

// Downloadable pet packs. Public (no code / Worker) — the catalog + animated webp come straight from
// jsDelivr. The injected fetch is proxy-aware in prod and faked in tests (same shape as NsfwFetch).
export type PetPackFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  headers: { get(name: string): string | null }
}>

const CT_EXT: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg' }
const EXT_MIME: Record<string, string> = { webp: 'image/webp', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg' }

function validItem(p: unknown): p is PetPackItem {
  const o = p as Partial<PetPackItem>
  return !!o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.base === 'string' &&
    typeof o.thumb === 'string' && Array.isArray(o.states) && o.states.length > 0
}

export async function petPackCatalog(fetchImpl: PetPackFetch): Promise<PetPackCatalog | { error: string }> {
  try {
    const res = await fetchImpl(PET_PACK_CATALOG_URL)
    if (!res.ok) return { error: `获取宠物目录失败(${res.status})` }
    const c = (await res.json()) as Partial<PetPackCatalog>
    return { pets: Array.isArray(c.pets) ? c.pets.filter(validItem) : [] }
  } catch { return { error: '无法连接宠物服务' } }
}

async function fetchImage(url: string, fetchImpl: PetPackFetch): Promise<{ buf: Buffer; ext: string } | { error: string }> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { error: `下载失败(${res.status})` }
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
    return { buf: Buffer.from(await res.arrayBuffer()), ext: CT_EXT[ct] || 'webp' }
  } catch { return { error: '下载失败' } }
}

// Download the pack's thumbnail (idle frame) for the gallery and cache it on disk → forge-bg:// URL.
export async function petPackPreview(item: PetPackItem, fetchImpl: PetPackFetch): Promise<{ url: string } | { error: string }> {
  const r = await fetchImage(item.thumb, fetchImpl)
  if ('error' in r) return r
  const stored = storeBackgroundFromBytes(r.buf, r.ext)
  if ('error' in stored) return stored
  return { url: backgroundImageUrl(stored.rel) }
}

// Download every state frame into pet-images under a caller-supplied local petId, returning the
// { name, images } shape PetPane already consumes. idle is required; other states are best-effort.
export async function petPackInstall(
  petId: string,
  item: PetPackItem,
  fetchImpl: PetPackFetch,
): Promise<{ name: string; images: Record<string, string> } | { error: string }> {
  const states = item.states.length ? item.states : ['idle']
  const images: Record<string, string> = {}
  for (const state of states) {
    const r = await fetchImage(`${item.base}/${state}.webp`, fetchImpl)
    if ('error' in r) {
      if (state === 'idle') return { error: `idle 帧${r.error}` }
      continue // optional state missing → fall back to idle at render time
    }
    const dataUrl = `data:${EXT_MIME[r.ext] || 'image/webp'};base64,${r.buf.toString('base64')}`
    const rel = writePetImageFromDataUrl(petId, state, dataUrl)
    if (rel) images[state] = rel
  }
  if (!images.idle) return { error: '缺少 idle 帧' }
  return { name: item.name, images }
}
