import { WALLPAPER_BLOCKLIST_URL, WALLPAPER_EXCLUDED_IDS } from '@shared/wallpaper'
import { readJson, writeJson } from '../config/store'
import { sysFile } from '../config/paths'
import { z } from 'zod'

// 壁纸远程下架名单。目录钉在 tag 上(每批打新 tag,老版本 app 只看得到自己那批),但下架必须**立刻对所有
// 版本生效** —— 所以名单单独放在分支上,URL 写死一次永不变更,历史版本读到的也是最新那份。
//
// ★ 落盘、且与本地已知名单取并集(「粘住」)。这是本模块唯一不显然的设计,理由:
// 下架的典型场景是版权投诉。如果只在内存里缓存,那么一次断网、或者用户干脆断网使用,被撤下的图就会
// 重新出现在画廊里 —— 恰恰是最不能发生的情况。所以一旦见过某个 id 被下架,就永久记住它。
// 代价是「误下架无法撤回」:名单里删掉一个 id 不会让它在老客户端复活。这是刻意的取舍 ——
// 下架宁可粘死,也不要因为一次网络抖动漏出去。真要复活,就换个新 id 重新发。
//
// fail-open 只发生在「从没成功拉到过名单」这一种情况:那时并集就是编译进包的基础名单,行为与从前一致,
// 不会因为一次拉取失败让整个画廊空掉。

const StoreSchema = z.object({ ids: z.array(z.string()).catch(() => []) }).catch(() => ({ ids: [] }))
const storeFile = () => sysFile('wallpaper-blocked.json')

export type WallpaperBlocklistFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

// 60s 内存缓存:画廊反复开关不会反复打 CDN。
const TTL_MS = 60_000
let cache: { at: number; ids: Set<string> } | null = null

export function __resetWallpaperBlocklistCache(): void { cache = null }

function readSticky(): Set<string> {
  return new Set(readJson(storeFile(), StoreSchema, () => ({ ids: [] as string[] })).ids)
}

function writeSticky(ids: Set<string>): void {
  try { writeJson(storeFile(), { ids: [...ids].sort() }) } catch { /* 写不进去就下次再说,不影响本次过滤 */ }
}

/**
 * 当前生效的下架 id 集合 = 编译进包的基础名单 ∪ 磁盘上记住的 ∪ 这次拉到的。
 * 任何一步失败都只是少一个来源,绝不抛。
 */
export async function wallpaperBlocklist(
  fetchImpl: WallpaperBlocklistFetch,
  now: number = Date.now(),
): Promise<Set<string>> {
  if (cache && now - cache.at < TTL_MS) return cache.ids

  const ids = new Set<string>([...WALLPAPER_EXCLUDED_IDS, ...readSticky()])
  try {
    const res = await fetchImpl(WALLPAPER_BLOCKLIST_URL)
    if (res.ok) {
      const body = (await res.json()) as { blocked?: unknown }
      const arr = Array.isArray(body?.blocked) ? body.blocked : []
      const fresh = arr.map(v => String(v).trim()).filter(Boolean)
      // 只增不减 —— 见文件头「粘住」那段。
      if (fresh.some(id => !ids.has(id))) {
        for (const id of fresh) ids.add(id)
        writeSticky(ids)
      }
    }
  } catch { /* 断网/端点异常 → 用已知的那份,画廊照常可用 */ }

  cache = { at: now, ids }
  return ids
}
