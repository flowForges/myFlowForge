// Built-in wallpapers: a curated set the app ships as an in-app gallery (Settings → Appearance).
// Unlike the license-gated NSFW packs, these are for everyone — NO activation code, NO Cloudflare Worker.
// Images are hosted on a public repo and served by jsDelivr (a free, unmetered CDN), so this feature does
// not consume the NSFW Worker's daily quota. The app downloads on demand and stores on disk like any
// uploaded background (forge-bg://), so nothing is bundled into the installer.

export const WALLPAPER_CATALOG_URL =
  'https://cdn.jsdelivr.net/gh/flowForges/wallpapers@v1/catalog.json'

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
