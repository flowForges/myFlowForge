import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { netErrorHint } from '../update/proxyFetch'
import { parseCodexManifest } from '@shared/codexPetManifest'
import type { CustomPet } from '@shared/petCustom'
import {
  CODEX_PET_MARKET_API, marketLocalId,
  petJsonUrlFromSpritesheet,
  type CodexMarketPet, type CodexMarketPage,
} from '@shared/codexPetMarket'
import { petImagesDir, petImageRelPath } from '../pet/petImageStore'
import { codexMarketCacheDir } from '../config/paths'
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
    // 缩略图优先 poster(单图正方 ~256²),不用 preview —— preview.webp 是多帧横向帧条,方形容器里会缩成一条细线。
    previewUrl: str('posterUrl') || str('previewUrl') || o.spritesheetUrl,
    spritesheetUrl: o.spritesheetUrl,
    petJsonUrl: petJsonUrlFromSpritesheet(o.spritesheetUrl),
    ownerName: str('ownerName') || str('ownerHandle'),
  }
}

// —— 目录缓存 ——
// codex-pets.net 是个第三方社区小站,慢/不通是常态。拉成功就把结果按页存一份,拉不到时拿它顶上,
// 页面至少还能浏览和安装(资源直链依然要网络,但用户不会面对一片空白)。缓存不设过期:能连上就会被
// 新结果覆盖,连不上时再旧也比空白强 —— UI 会明确标出「离线 · 显示上次结果」。
function catalogCacheFile(dir: string, page: number): string {
  return join(dir, `catalog-p${page}.json`)
}

function readCatalogCache(dir: string, page: number): CodexMarketPage | null {
  try {
    const c = JSON.parse(readFileSync(catalogCacheFile(dir, page), 'utf8')) as CodexMarketPage
    return Array.isArray(c?.pets) ? c : null
  } catch { return null }
}

function writeCatalogCache(dir: string, page: number, data: CodexMarketPage): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(catalogCacheFile(dir, page), JSON.stringify(data), 'utf8')
  } catch { /* 缓存是尽力而为,写不进去不影响本次结果 */ }
}

// cacheDir 可注入(与 codexMarketInstall 的 baseDir 同一约定),测试因此不必碰真实 home 目录。
export async function codexMarketCatalog(
  page: number,
  fetchImpl: MarketFetch,
  cacheDir: string = codexMarketCacheDir(),
): Promise<CodexMarketPage | { error: string }> {
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  // 失败时统一走这里:有缓存就降级展示(带 stale 标记),没有才把错误抛给 UI。
  const degrade = (error: string): CodexMarketPage | { error: string } => {
    const cached = readCatalogCache(cacheDir, p)
    return cached ? { ...cached, stale: true, staleReason: error } : { error }
  }
  try {
    const res = await fetchImpl(`${CODEX_PET_MARKET_API}?page=${p}`)
    if (!res.ok) {
      return degrade(res.status === 429
        ? '宠物市场限流了(429)，稍后再试'
        : `获取宠物列表失败(HTTP ${res.status})`)
    }
    const c = (await res.json()) as Record<string, unknown>
    const pets = (Array.isArray(c.pets) ? c.pets.map(normalizePet).filter((x): x is CodexMarketPet => !!x) : [])
    const out: CodexMarketPage = {
      pets,
      page: typeof c.page === 'number' ? c.page : p,
      pageSize: typeof c.pageSize === 'number' ? c.pageSize : pets.length,
      total: typeof c.total === 'number' ? c.total : pets.length,
      totalPages: typeof c.totalPages === 'number' ? c.totalPages : 1,
    }
    if (pets.length) writeCatalogCache(cacheDir, p, out)   // 空结果不覆盖缓存(可能是站点临时抽风)
    return out
  } catch (e) {
    return degrade(netErrorHint(e))
  }
}

async function fetchBytes(url: string, fetchImpl: MarketFetch): Promise<{ buf: Buffer; ext: string } | { error: string }> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { error: `下载失败(HTTP ${res.status})` }
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
    return { buf: Buffer.from(await res.arrayBuffer()), ext: ct.includes('png') ? 'png' : 'webp' }
  } catch (e) { return { error: netErrorHint(e) } }
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
    if (!res.ok) return { ok: false, error: `pet.json 下载失败(HTTP ${res.status})` }
    manifestRaw = await res.json()
  } catch (e) { return { ok: false, error: `pet.json 下载失败 —— ${netErrorHint(e)}` } }
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
