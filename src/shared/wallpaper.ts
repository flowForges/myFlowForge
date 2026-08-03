// Built-in wallpapers: a curated set the app ships as an in-app gallery (Settings → Appearance).
// Unlike the license-gated NSFW packs, these are for everyone — NO activation code, NO Cloudflare Worker.
// Images are hosted on a public repo and served by jsDelivr (a free, unmetered CDN), so this feature does
// not consume the NSFW Worker's daily quota. The app downloads on demand and stores on disk like any
// uploaded background (forge-bg://), so nothing is bundled into the installer.

export const WALLPAPER_CATALOG_URL =
  'https://cdn.jsdelivr.net/gh/flowForges/wallpapers@v2/catalog.json'

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

// Client-side exclusion list: catalog ids hidden from the built-in gallery even though the remote
// (jsDelivr-cached, @v1-pinned) catalog still ships them — e.g. an image whose composition renders
// poorly as an app background. Filtered out in wallpaperService.wallpaperCatalog, so the gallery never
// lists them and no thumbnail/full download is ever requested for them.
export const WALLPAPER_EXCLUDED_IDS = new Set<string>([
  'cm01', // 【纯美】银发白衣仙侠少女:样式不对,下架
])
