// Built-in wallpapers: a curated set the app ships as an in-app gallery (Settings → Appearance).
// Unlike the license-gated NSFW packs, these are for everyone — NO activation code, NO Cloudflare Worker.
// Images are hosted on a public repo and served by jsDelivr (a free, unmetered CDN), so this feature does
// not consume the NSFW Worker's daily quota. The app downloads on demand and stores on disk like any
// uploaded background (forge-bg://), so nothing is bundled into the installer.

export const WALLPAPER_CATALOG_URL =
  'https://cdn.jsdelivr.net/gh/flowForges/wallpapers@v3/catalog.json'

// 远程下架名单。目录钉在 tag 上(每批壁纸打一个新 tag,老版本 app 看不到新壁纸 —— 这是刻意的),
// 但「某张图有版权问题要立刻撤下」不能等发版,也不该只对新版本生效。
//
// 所以名单单独放在**分支**上:tag 不可变、分支可变,这个 URL 写死一次就永远不用改,
// 于是**所有历史版本的 app 都会读到同一份最新名单**。
//
// ★ 走 jsDelivr 而不是 Cloudflare Worker:壁纸这条线本来就在 jsDelivr 上(免费不限量),
// 加一个小 JSON 不消耗 Worker 的免费额度 —— 额度只花在 NSFW/插件那条线上。
// ★ 只在用户打开壁纸库时拉一次(和目录同一时机),不打开就一次请求都没有。
export const WALLPAPER_BLOCKLIST_URL =
  'https://cdn.jsdelivr.net/gh/flowForges/wallpapers@main/blocked.json'

// 壁纸纵向焦点默认值(%):0=顶部对齐、50=居中、100=底部对齐。默认略偏上,以尽量保住竖构图壁纸的画面上部
// (人物头部),减少 `cover` 裁剪造成的"削头"。CSS 里的 var() 兜底值需与此保持一致。
export const DEFAULT_BG_POSITION = 35

export interface WallpaperItem {
  id: string
  cat: string        // 分类,如「风景游戏」「纯美」
  name: string
  url: string        // 整图(应用时下载)
  thumb?: string     // 缩略图(画廊预览用);缺省则预览回退到整图 url
  desc?: string
}

export interface WallpaperCatalog {
  wallpapers: WallpaperItem[]
}

// 编译进包的基础排除名单 —— 与远程名单取并集。这里放「样式不合适」这类永久判断;需要随时生效的下架
// (版权等)走上面那个远程名单,不必发版。
// 两者都只影响**画廊列表**:已经下载/正在用的壁纸不受影响(用户本地的东西不动)。
export const WALLPAPER_EXCLUDED_IDS = new Set<string>([
  'cm01', // 【纯美】银发白衣仙侠少女:样式不对,下架
])
