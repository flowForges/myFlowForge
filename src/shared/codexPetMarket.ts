// codex-pets.net 宠物市场(第三方社区宠物库)接入。列表 API 返回分页的宠物;每只是 Codex v2 格式
// (pet.json spriteVersionNumber:2 + spritesheet.webp),正好是本 app 已支持的 atlas 格式。
// 只放常量+类型;抓取/安装在 src/main/codexPetMarket/service.ts,渲染在 PetMarketPane.tsx。

export const CODEX_PET_MARKET_SITE = 'codex-pets.net'
export const CODEX_PET_MARKET_HOME = 'https://codex-pets.net'
export const CODEX_PET_MARKET_API = 'https://codex-pets.net/api/pets'
export const CODEX_PET_MARKET_PAGE_SIZE = 30

// gating:插件市场里这个官方插件启用后,才显示「宠物市场」设置页。main(officialCatalog)与 renderer(App)共用。
export const PET_MARKET_PLUGIN_ID = 'forge-official-pet-market'

// 已安装的市场宠物,其本地 customPets id 前缀 —— 用来标记来源(「来自 codex-pets.net」)且不与本地 codex 导入(codex-)冲突。
export const CODEX_MARKET_ID_PREFIX = 'codexmkt-'

// 归一化后的一只市场宠物(service 从 API 原始字段整理而来)。
export interface CodexMarketPet {
  id: string            // 站点侧 id,如 "nagato-yuki"
  displayName: string
  previewUrl: string    // 缩略图直链(.webp)
  spritesheetUrl: string // 精灵图直链(.webp)
  petJsonUrl: string     // 由 spritesheetUrl 同目录推导的 pet.json 直链
  ownerName: string      // 作者(归属标注用)
}

export interface CodexMarketPage {
  pets: CodexMarketPet[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  // 这一页来自本地缓存(这次没连上 codex-pets.net)。UI 据此打「离线 · 显示上次结果」的横幅,
  // staleReason 是本次失败的真实原因(超时/DNS/限流…),让用户知道该修什么。
  stale?: boolean
  staleReason?: string
}

// 由 spritesheet 直链推出同目录的 pet.json 直链:替换最后一个路径段(连带 query)为 pet.json。
// 例 https://codex-pets.net/assets/pets/v/<ver>/<id>/spritesheet.webp → .../<id>/pet.json
export function petJsonUrlFromSpritesheet(spritesheetUrl: string): string {
  return spritesheetUrl.replace(/[^/]+(\?.*)?$/, 'pet.json')
}

// 市场宠物装到本地后的 customPets id(带来源前缀)。main 用它写盘,renderer 用它判「是否已安装」。确定性:
// 同一站点 id → 同一本地 id → 重装即 upsert 不重复。
export function marketLocalId(siteId: string): string {
  const safe = siteId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_')
  return `${CODEX_MARKET_ID_PREFIX}${safe}`
}
