// 主题皮肤注册表(纯元数据)。颜色/motif 活在 src/renderer/theme/skins.css 的 :root[data-skin=id] 块里;
// 这里只提供设置画廊 UI 要用的展示信息 + 一份「已知皮肤 id」清单供 applyTheme 防御未知值。
// 加一套皮肤 = 这里加一条 + skins.css 加对应两块(palette + motif)。两边 id 必须一致(skins.test.ts 守 id 唯一)。

export interface SkinMeta {
  id: string
  name: string            // 中文名(熔炉)
  en: string              // 拉丁副名(Forge)
  tag: string             // 一句话标签(本命 · on-brand)
  vibe: string            // 一句话气质描述
  base: 'dark' | 'light'  // 底色基调(决定缩略图明暗 + 文档归类)
  swatches: [string, string, string, string]  // 4 个基色 hex(bg / panel / accent / accent2),画廊色卡用
  pet?: string            // 未来:搭调的宠物 id(v2 接宠物切换;v1 仅登记不生效)
}

export const BUILTIN_SKINS: SkinMeta[] = [
  { id: 'forge',  name: '熔炉',   en: 'Forge',     tag: '本命 · on-brand', base: 'dark',
    vibe: '暗铁与熔金,主题从 FlowForge 自己的名字长出来', swatches: ['#14100c', '#2e281f', '#ff7a1a', '#ffce5c'] },
  { id: 'aurora', name: '极夜',   en: 'Aurora',    tag: '氛围 · 深色', base: 'dark',
    vibe: '极地长夜里流动的极光,冷静高级耐看', swatches: ['#0a0e1a', '#242a37', '#4fd6c4', '#a98bff'] },
  { id: 'ink',    name: '墨山水', en: 'Ink',       tag: '东方 · 浅色', base: 'light',
    vibe: '原创水墨,宣纸+远山+朱砂印,把东方做成格调而非喜庆', swatches: ['#f1ebdf', '#faf6ec', '#c0392b', '#2c2b27'] },
  { id: 'abyss',  name: '深海',   en: 'Abyss',     tag: '静谧 · 深色', base: 'dark',
    vibe: '生物荧光深海,极暗极静,护眼深夜档', swatches: ['#050d10', '#1e2d2f', '#22d3c5', '#7cffb2'] },
  { id: 'synth',  name: '合成波', en: 'Synthwave', tag: '大胆 · 潮', base: 'dark',
    vibe: '80s 霓虹+透视网格,冲击力最强,社媒好看', swatches: ['#140720', '#2b2536', '#ff4d8d', '#21e6ff'] },
  { id: 'moss',   name: '苔庭',   en: 'Mossgarden', tag: '治愈 · 浅色', base: 'light',
    vibe: '慵懒植物庭院,低饱和温柔,久看不累', swatches: ['#efece2', '#f8f5ec', '#6f8f5a', '#c67b4e'] },
  { id: 'lapis',  name: '青金',   en: 'Lapis',     tag: '雅致 · 深色', base: 'dark',
    vibe: '青金石的群青底子里嵌着金箔,沉静里透出一线鎏金', swatches: ['#0b1430', '#1c2b57', '#e8b44a', '#4f7fd6'] },
]

export const KNOWN_SKIN_IDS: ReadonlySet<string> = new Set(BUILTIN_SKINS.map(s => s.id))

// id → 明暗基调。皮肤生效时必须把 data-theme 同步成它的 base:很多组件按 [data-theme="dark"] 写了硬编码色
// (白字/深底),若只打 data-skin 不改 data-theme,浅色皮肤上那些 dark 规则仍生效 → 白字失明、深块突兀。
export const SKIN_BASE: Record<string, 'dark' | 'light'> = Object.fromEntries(BUILTIN_SKINS.map(s => [s.id, s.base]))
