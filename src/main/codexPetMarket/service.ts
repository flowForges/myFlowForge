import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseCodexManifest } from '@shared/codexPetManifest'
import type { CustomPet } from '@shared/petCustom'
import {
  CODEX_PET_MARKET_API, marketLocalId,
  petJsonUrlFromSpritesheet,
  type CodexMarketPet, type CodexMarketPage,
} from '@shared/codexPetMarket'
import { petImagesDir, petImageRelPath } from '../pet/petImageStore'
import { storeBackgroundFromBytes, backgroundImageUrl } from '../appearance/backgroundStore'

// Injected fetch — proxy-aware in prod (makeContentFetch), faked in tests. Same shape as PetPackFetch.
export type MarketFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  headers: { get(name: string): string | null }
}>

function normalizePet(p: unknown): CodexMarketPet | null {
  const o = p as Record<string, unknown>
  if (!o || typeof o.id !== 'string' || typeof o.spritesheetUrl !== 'string') return null
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  return {
    id: o.id,
    displayName: str('displayName') || o.id,
    previewUrl: str('previewUrl') || str('posterUrl') || o.spritesheetUrl,
    spritesheetUrl: o.spritesheetUrl,
    petJsonUrl: petJsonUrlFromSpritesheet(o.spritesheetUrl),
    ownerName: str('ownerName') || str('ownerHandle'),
  }
}

export async function codexMarketCatalog(page: number, fetchImpl: MarketFetch): Promise<CodexMarketPage | { error: string }> {
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  try {
    const res = await fetchImpl(`${CODEX_PET_MARKET_API}?page=${p}`)
    if (!res.ok) return { error: `获取宠物列表失败(${res.status})` }
    const c = (await res.json()) as Record<string, unknown>
    const pets = (Array.isArray(c.pets) ? c.pets.map(normalizePet).filter((x): x is CodexMarketPet => !!x) : [])
    return {
      pets,
      page: typeof c.page === 'number' ? c.page : p,
      pageSize: typeof c.pageSize === 'number' ? c.pageSize : pets.length,
      total: typeof c.total === 'number' ? c.total : pets.length,
      totalPages: typeof c.totalPages === 'number' ? c.totalPages : 1,
    }
  } catch { return { error: '无法连接 codex-pets.net' } }
}

async function fetchBytes(url: string, fetchImpl: MarketFetch): Promise<{ buf: Buffer; ext: string } | { error: string }> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { error: `下载失败(${res.status})` }
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
    return { buf: Buffer.from(await res.arrayBuffer()), ext: ct.includes('png') ? 'png' : 'webp' }
  } catch { return { error: '下载失败' } }
}

// Thumbnail → cached on disk as forge-bg:// (renderer can't load codex-pets.net images directly: CORS/CSP/proxy).
export async function codexMarketPreview(url: string, fetchImpl: MarketFetch): Promise<{ url: string } | { error: string }> {
  const r = await fetchBytes(url, fetchImpl)
  if ('error' in r) return r
  const stored = storeBackgroundFromBytes(r.buf, r.ext)
  if ('error' in stored) return stored
  return { url: backgroundImageUrl(stored.rel) }
}

// Download pet.json (validate v2) + spritesheet.webp into pet-images/<localId>/, returning a CustomPet
// with the atlas ref so the existing forge-pet:// protocol + PetAtlasSprite render it — no new render path.
export async function codexMarketInstall(item: CodexMarketPet, fetchImpl: MarketFetch, baseDir: string = petImagesDir()): Promise<{ ok: true; pet: CustomPet } | { ok: false; error: string }> {
  let manifestRaw: unknown
  try {
    const res = await fetchImpl(item.petJsonUrl)
    if (!res.ok) return { ok: false, error: `pet.json 下载失败(${res.status})` }
    manifestRaw = await res.json()
  } catch { return { ok: false, error: 'pet.json 下载失败' } }
  const parsed = parseCodexManifest(manifestRaw)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const sheet = await fetchBytes(item.spritesheetUrl, fetchImpl)
  if ('error' in sheet) return { ok: false, error: `精灵图${sheet.error}` }

  const id = marketLocalId(item.id)
  mkdirSync(join(baseDir, id), { recursive: true })
  const rel = petImageRelPath(id, 'spritesheet', 'webp')  // "<id>/spritesheet.webp"
  writeFileSync(join(baseDir, rel), sheet.buf)
  return { ok: true, pet: { id, name: item.displayName, atlas: { path: rel, version: 2 } } }
}
