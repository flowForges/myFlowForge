import { PET_PACK_CATALOG_URL, type PetPackCatalog, type PetPackItem, type GrowthPackItem } from '../../shared/petPack'
import { parseGrowthManifest } from '../../shared/growthPet'
import type { CustomPetCfg } from '../../shared/types'
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

function validGrowthItem(p: unknown): p is GrowthPackItem {
  const o = p as Partial<GrowthPackItem>
  return !!o && o.kind === 'growth' && typeof o.id === 'string' && typeof o.name === 'string' &&
    typeof o.base === 'string' && typeof o.manifest === 'string' && typeof o.thumb === 'string' &&
    Array.isArray(o.stages) && o.stages.length > 0 &&
    o.stages.every(s => typeof s?.sheet === 'string' && Number.isInteger(s?.from) && s.from >= 0)
}

export async function petPackCatalog(fetchImpl: PetPackFetch): Promise<PetPackCatalog | { error: string }> {
  try {
    const res = await fetchImpl(PET_PACK_CATALOG_URL)
    if (!res.ok) return { error: `获取宠物目录失败(${res.status})` }
    const c = (await res.json()) as Partial<PetPackCatalog>
    return {
      pets: Array.isArray(c.pets) ? c.pets.filter(validItem) : [],
      // 老 catalog 没有这一节 —— 那就只是没有成长宠物可下,不该让整个宠物库报错。
      growth: Array.isArray(c.growth) ? c.growth.filter(validGrowthItem) : [],
    }
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
export async function petPackPreview(item: { thumb: string }, fetchImpl: PetPackFetch): Promise<{ url: string } | { error: string }> {
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

// 下载一个成长宠物包:先取 pet.json(atlas/actions/stages 的唯一事实源),再逐阶段下载 atlas 落盘,
// 最后拼出 PetPane 已经在消费的那个 CustomPetCfg 形状(growth 里的 sheet 换成本地相对路径)。
//
// 为什么不信 catalog 里的 stages:那份是给画廊做预览和排序用的摘要,真正的契约在包自己的 pet.json 里
// (它还带着 atlas 网格和 actions 行号)。两处都读会有对不上的风险,所以以 pet.json 为准,catalog 只用来
// 发现和展示。
export async function growthPackInstall(
  petId: string,
  item: GrowthPackItem,
  fetchImpl: PetPackFetch,
): Promise<{ pet: CustomPetCfg } | { error: string }> {
  let raw: unknown
  try {
    const res = await fetchImpl(item.manifest)
    if (!res.ok) return { error: `获取 pet.json 失败(${res.status})` }
    raw = await res.json()
  } catch { return { error: '无法连接宠物服务' } }

  // 用与本地装包完全相同的校验器 —— 远程包不能享受任何豁免(包括「老包的 at 会被明确拒绝」这条)。
  const parsed = parseGrowthManifest(raw)
  if (!parsed.ok) return { error: parsed.error }
  const m = parsed.manifest

  const stages: { from: number; name?: string; sheet: string }[] = []
  for (let i = 0; i < m.stages.length; i++) {
    const st = m.stages[i]
    const r = await fetchImage(`${item.base}/${st.sheet}`, fetchImpl)
    if ('error' in r) return { error: `阶段 ${i + 1}(${st.name ?? st.sheet})${r.error}` }
    const dataUrl = `data:${EXT_MIME[r.ext] || 'image/png'};base64,${r.buf.toString('base64')}`
    // 阶段图借用 per-state 的存储位:key 用 stage-<i>,和 idle/working 那些状态名不会撞。
    const rel = writePetImageFromDataUrl(petId, `stage-${i}`, dataUrl)
    if (!rel) return { error: `阶段 ${i + 1} 写入失败` }
    stages.push(st.name ? { from: st.from, name: st.name, sheet: rel } : { from: st.from, sheet: rel })
  }

  return { pet: { id: petId, name: m.name, growth: { atlas: m.atlas, actions: m.actions, stages } } }
}
