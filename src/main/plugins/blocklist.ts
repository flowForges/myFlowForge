import { PLUGIN_BLOCKLIST_URL } from '@shared/plugins'

// 插件广场远程下架名单。向 Worker 的 public /plugins-blocklist 端点拉一个 { blocked: [...ids] },listCatalog
// 据此把「未安装」的被下架插件从广场里隐藏。设计要点:
//   • FAIL-OPEN:网络失败/端点异常 → 返回上次缓存,没有缓存就返回空集(即照常显示全部)。宁可漏隐藏一个坏插件,
//     也不能因为一次断网把整个广场清空。
//   • 60s 内存缓存:改一次 Worker 变量,用户端最多 1 分钟内生效;广场频繁重开也不会反复打 Worker。
// 注入 fetch(与 nsfw/wallpaper 一样走用户代理,测试里可替身),所以本模块自身不直接碰网络。
export type BlocklistFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const TTL_MS = 60_000
let cache: { at: number; ids: Set<string> } | null = null

export function __resetPluginBlocklistCache() { cache = null } // 测试用

export async function pluginBlocklist(fetchImpl: BlocklistFetch, now: number = Date.now()): Promise<Set<string>> {
  if (!PLUGIN_BLOCKLIST_URL) return new Set()                    // Worker 未配置 → 功能休眠
  if (cache && now - cache.at < TTL_MS) return cache.ids         // 命中缓存
  try {
    const res = await fetchImpl(PLUGIN_BLOCKLIST_URL)
    if (!res.ok) return cache?.ids ?? new Set()                  // 非 200 → 沿用旧缓存 / 空(fail-open)
    const body = (await res.json()) as { blocked?: unknown }
    const arr = Array.isArray(body?.blocked) ? body.blocked : []
    const ids = new Set(arr.map(v => String(v).trim()).filter(Boolean))
    cache = { at: now, ids }
    return ids
  } catch {
    return cache?.ids ?? new Set()                               // 断网/解析失败 → fail-open
  }
}
