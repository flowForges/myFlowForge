// Downloadable desktop-pet packs. Like the built-in wallpapers, these are for everyone — NO activation
// code, NO Cloudflare Worker. The animated webp are hosted on a public repo and served by jsDelivr; the
// app downloads a pack on demand and stores its frames on disk (forge-pet://), so only ONE pet
// (white-catgirl) ships bundled and the installer stays ~60MB smaller.

// ★ 用分支(@main)而不是 tag(@v1)。jsDelivr 把带 tag 的 URL 当**不可变**内容:它缓存的是
// 「tag → commit」这一层解析,把 v1 前移之后既有路径永远发旧字节,purge 文件路径也救不回来
// (重新解析拿到的还是那个被缓存的旧 SHA)。实测:同一时刻 @main 已是新内容、@v1 还是旧的。
// 分支路径最多缓存 12 小时,且 purge 真的有效 —— 内容更新不必跟着应用发版走。
// 代价:没有版本钉死,main 上推错东西会立刻影响所有客户端。内容仓库只有我们自己写,可接受。
export const PET_PACK_CATALOG_URL =
  'https://cdn.jsdelivr.net/gh/flowForges/pet-packs@main/catalog.json'

export interface PetPackItem {
  id: string
  name: string
  desc?: string
  states: string[]         // 该宠物提供的状态帧,如 ['idle','working','confirm','input','done']
  base: string             // 帧目录:每个状态图 = `${base}/${state}.webp`
  thumb: string            // 画廊预览用(通常是 idle.webp)
}

// 成长宠物包的目录条目。和普通包不是一回事,所以在 catalog 里单列一节:普通包是「每个状态一张图」,
// 成长包是「一份 pet.json + 每阶段一张 atlas」,安装路径完全不同。
export interface GrowthPackStageItem {
  /** 进入该阶段所需的今日 token 绝对值(含);最后一条没有上界。见 shared/growthPet.ts。 */
  from: number
  name?: string
  /** 相对 base 的文件名。 */
  sheet: string
}
export interface GrowthPackItem {
  kind: 'growth'
  id: string
  name: string
  desc?: string
  /** 阶段图目录:每阶段图 = `${base}/${stage.sheet}`。 */
  base: string
  /** pet.json 的完整 URL —— atlas/actions 这些只在它里面,目录条目不重复一份。 */
  manifest: string
  thumb: string
  stages: GrowthPackStageItem[]
}

export interface PetPackCatalog {
  pets: PetPackItem[]
  /** 可选:老 catalog(或临时故障)没有这一节时,宠物库只是不显示成长宠物,不报错。 */
  growth?: GrowthPackItem[]
}
