// Downloadable desktop-pet packs. Like the built-in wallpapers, these are for everyone — NO activation
// code, NO Cloudflare Worker. The animated webp are hosted on a public repo and served by jsDelivr; the
// app downloads a pack on demand and stores its frames on disk (forge-pet://), so only ONE pet
// (white-catgirl) ships bundled and the installer stays ~60MB smaller.

export const PET_PACK_CATALOG_URL =
  'https://cdn.jsdelivr.net/gh/flowForges/pet-packs@v1/catalog.json'

export interface PetPackItem {
  id: string
  name: string
  desc?: string
  states: string[]         // 该宠物提供的状态帧,如 ['idle','working','confirm','input','done']
  base: string             // 帧目录:每个状态图 = `${base}/${state}.webp`
  thumb: string            // 画廊预览用(通常是 idle.webp)
}

export interface PetPackCatalog {
  pets: PetPackItem[]
}
