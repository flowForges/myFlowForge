import type { Appearance } from '@shared/types'
import { DEFAULT_BG_POSITION } from '@shared/wallpaper'
import { KNOWN_SKIN_IDS, SKIN_BASE } from '@shared/skins'
import { PALETTE_PROPS, paletteVars, type WallpaperPalette } from './wallpaperPalette'

export function prefersDark(): boolean {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

// 叠在自定义强调色上的文字色:按所选 #rrggbb 的感知亮度(sRGB 加权)判深/浅,亮色配深字、暗色配白字,
// 保证强调色按钮上的文字可读。非法输入(非 6 位 hex)回落到白字。与预设色里 --on-accent 的处理同理。
export function onAccentFor(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return 'oklch(99% 0 0)'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return lum > 0.5 ? 'oklch(20% 0 0)' : 'oklch(99% 0 0)'
}

// 壁纸「可见度」→ 浅色主题下的饱和补偿系数。可见度越低,图被白底吃掉的彩度越多,补得越多;
// 可见度 100% 时不做任何补偿(1)。系数刻意保守(最多 1.9 倍),只为把奶白雾拉回成"淡而有色",
// 不是把壁纸调成霓虹。非数字 / 越界输入夹到 [0.05, 1] 再算,保证永远产出有限值。
export function bgSaturation(opacity: number): number {
  const o = Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, opacity)) : 0.35
  return Number((1 + 0.9 * (1 - o)).toFixed(3))
}

// 壁纸「可见度」→ chrome 面板(侧栏/检视区/顶栏/底栏)要额外补多厚一层自身底色,单位是百分比字符串。
//
// 为什么需要:这几个面板是半透明的,可见度越高,它们背后的实际底色就越接近壁纸本身。而壁纸经常大面积是
// 亮的 —— 实测用户那张(人物插画)【中位亮度就是纯白】—— 深色系的浅灰小字(阶段名、模型名、路径、会话名,
// 全走 muted/faint)于是变成浅色字压在白底上。算过账:可见度 85% 时 --muted 对比度只有 1.02:1,
// 等于完全看不见(WCAG 正文要求 4.5:1)。这不是配色没调好,是"半透明面板 + 亮壁纸"的必然结果。
// 补的是 var(--bg-2)(主题/皮肤自带),所以深色补深、浅色补浅,两个基调都朝"字能读"的方向走。
//
// 斜率是按对比度反推的,不是拍脑袋:在上述最坏情况(壁纸纯白)下,补到 ~72% 才能让 --muted 回到 4.5:1、
// --faint 回到 3:1。所以 35% 以下不补(保持原本验证过的通透观感),85% 时给满 78%,再往上封顶。
// 代价是可见度拉满时侧栏/检视区基本不透壁纸了 —— 中间会话区仍是全透的,壁纸该看还是看得见。
export function chromeVeil(opacity: number): string {
  const o = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0.35
  const t = Math.min(1, Math.max(0, (o - 0.35) / 0.5))
  return `${Number((t * 78).toFixed(1))}%`
}

export function applyTheme(a: Appearance, palette?: WallpaperPalette | null): void {
  const root = document.documentElement
  // 壁纸自动配色(见 wallpaperPalette.ts):开关打开且已取到调色板时,它接管明暗基调 + 整套中性色,
  // 并盖过手选皮肤(否则皮肤的 motif 与它的配色会打架)。取不到调色板时静默回落到下面的常规路径。
  const auto = a.autoWallpaperTheme && palette ? palette : null
  // 灰度壁纸取不出点缀色(hueAccent=null)→ 只接管中性色,强调色仍交还给用户自己的选择。
  // 用户在强调色里选了「跟随壁纸」以外的颜色时(wallpaperAccentAuto===false)走同一条路:壁纸的取色
  // 规则再准也难保每张都合口味,而这条路径本来就为灰度壁纸跑通了,复用它比另开一套稳。
  // 缺省(undefined)= 跟随,所以只认显式的 false。
  const autoAccent = !!auto && auto.hueAccent != null && a.wallpaperAccentAuto !== false
  // 主题皮肤(叠加层):有效内置 id → 打 data-skin(skins.css 的 :root[data-skin] 覆盖整套 token + 显示 motif)。
  const skin = auto ? '' : (a.activeSkin && KNOWN_SKIN_IDS.has(a.activeSkin) ? a.activeSkin : '')
  // 皮肤生效时 data-theme 跟随皮肤的明暗基调(light/dark),让所有 [data-theme=...] 作用域的样式(尤其一些
  // 硬编码白字/深底的 dark 规则)与皮肤一致 —— 否则浅色皮肤上仍会命中 dark 规则导致白字失明。无皮肤时用用户
  // 自己的主题(auto 跟随系统)。
  const theme = auto ? auto.base : skin ? SKIN_BASE[skin] : (a.theme === 'auto' ? (prefersDark() ? 'dark' : 'light') : a.theme)
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-accent', a.accent)
  if (skin) root.setAttribute('data-skin', skin)
  else root.removeAttribute('data-skin')
  // 自定义强调色:accent==='custom' 时,把用户选的颜色直接写成内联 --accent 及其派生基色(内联样式优先级高过
  // tokens.css 里 [data-accent=...] 的规则)。其它深浅/hover/ring 都在各站点用 color-mix(var(--accent)) 现算,
  // 故只需喂 4 个:--accent 本色、--accent-dim 低透明度底色、--run 运行态(取同色)、--on-accent 叠加其上的文字色
  // (按所选色的感知亮度判黑/白,保证按钮文字可读)。切回预设色时清掉这些内联,交还给 data-accent 属性选择器。
  // 先无条件清掉上一轮内联的整套配色属性(壁纸配色 + 自定义强调色共用这批),再按本轮情况重写,
  // 保证关掉开关/换回预设强调色时不会残留。
  for (const prop of PALETTE_PROPS) root.style.removeProperty(prop)
  // 强调色不跟随时,把 hueAccent 抹成 null 再产出 —— paletteVars 见到 null 就不写 accent 四件套,
  // 于是 --accent 交还给 [data-accent] 属性选择器(预设色)或下面的 custom 内联(自定义色)。
  if (auto) {
    const src = autoAccent ? auto : { ...auto, hueAccent: null }
    for (const [prop, value] of Object.entries(paletteVars(src))) root.style.setProperty(prop, value)
  }
  // 皮肤生效时不写自定义强调色 —— 皮肤自带 accent。预设强调色早就被皮肤接管了(skins.css 最后引入,同特异性
  // 靠顺序取胜),唯独「自定义」走内联、优先级最高,于是压过皮肤:画廊色卡上明明是金色,套上去却是用户那抹
  // 洋红,预览与结果对不上,而且没有任何提示。现在两种强调色在皮肤面前行为一致 = 皮肤说了算。
  // 取消皮肤后自定义色自动回来(这段每轮重算,上面已无条件清过内联)。
  const custom = !autoAccent && !skin && a.accent === 'custom' ? (a.accentCustom ?? '').trim() : ''
  if (custom) {
    root.style.setProperty('--accent', custom)
    root.style.setProperty('--accent-dim', `color-mix(in oklab, ${custom} 16%, transparent)`)
    root.style.setProperty('--run', custom)
    root.style.setProperty('--on-accent', onAccentFor(custom))
  }
  root.setAttribute('data-vibrancy', a.vibrancy ? 'on' : 'off')
  // 磨砂度 drives the glass system: any blurAmount > 0 turns on the frosted-panel CSS (data-glass) and
  // scales the panel backdrop-blur via a CSS var (0..1 → 0..designed strength). The window-level desktop
  // vibrancy is handled in the main process at window creation. Keep the legacy `glass` flag as an OR.
  const blur = a.blurAmount ?? 0
  root.setAttribute('data-glass', blur > 0 || a.glass ? 'on' : 'off')
  root.style.setProperty('--glass-blur-strength', String(blur > 0 ? blur : 1))
  root.setAttribute('data-density', a.density)
  // 应用界面字号(px)通过主进程的 setZoomFactor(fontZoom)整窗缩放生效,不在此设根字号,避免与缩放叠加。
  // 会话区(消息输入/输出)字号独立:.msg-body 与 .composer textarea 基础 14px,乘以此缩放系数
  // (chat.css 消费 --chat-font-scale)。chatFontSize 现为 px,scale = px / 14;旧枚举字符串仍容错映射。
  const LEGACY_CHAT = { small: 12.5, medium: 14, large: 16 } as Record<string, number>
  const chatPx = typeof a.chatFontSize === 'number' ? a.chatFontSize : (LEGACY_CHAT[a.chatFontSize as unknown as string] ?? 14)
  root.style.setProperty('--chat-font-scale', String(chatPx / 14))
  // 会话区行距/字间距:独立于字号,chat.css 的 .msg-body 消费这两个变量。非数字兜底到舒展的默认。
  root.style.setProperty('--chat-line-height', String(typeof a.chatLineHeight === 'number' ? a.chatLineHeight : 1.7))
  root.style.setProperty('--chat-letter-spacing', `${typeof a.chatLetterSpacing === 'number' ? a.chatLetterSpacing : 0}em`)
  // 应用字体族:非空则覆盖 --font(带系统栈兜底);空则清除,回落到 tokens.css 里的系统字体栈。
  if (a.fontFamily && a.fontFamily.trim()) {
    root.style.setProperty('--font', `${a.fontFamily.trim()}, -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`)
  } else {
    root.style.removeProperty('--font')
  }
  // 文本字重:直接把数值(300–600)写进 --app-fw,只作用于 body 基础字重(见 global.css 的 body 规则),
  // 不动已显式加重的标题/强调文本。旧枚举值经 schema 迁移后到这里已是数字;非数字兜底 450。
  root.style.setProperty('--app-fw', String(typeof a.textWeight === 'number' ? a.textWeight : 450))
  // Background image: expose the image + its opacity as CSS vars and a scope attribute; the CSS
  // (.app-bg-layer for 'app', .chat::before for 'chat') keys off data-bg-scope. Off when no image.
  const bgOn = !!a.bgImage && a.bgScope && a.bgScope !== 'off'
  root.setAttribute('data-bg-scope', bgOn ? a.bgScope : 'off')
  root.style.setProperty('--app-bg-image', a.bgImage ? `url("${a.bgImage}")` : 'none')
  root.style.setProperty('--app-bg-opacity', String(a.bgOpacity ?? 0.35))
  // 浅色主题下壁纸会"发奶白"的补偿系数(只有 global.css 的 [data-theme=light] 规则消费它,深色不受影响)。
  // 见 global.css .app-bg-layer 下方注释:浅色把图混向近白 → 明度不降、彩度被等比抹掉。按可见度反比补回,
  // 可见度 100% 时为 1(不动),越淡补得越多,上限 1.9(可见度 5% 时)。
  root.style.setProperty('--app-bg-sat', String(bgSaturation(a.bgOpacity ?? 0.35)))
  // 可见度越高,chrome 面板越要补自身底色,否则小字在亮壁纸上失明(见 chromeVeil 说明)。
  root.style.setProperty('--chrome-veil', chromeVeil(a.bgOpacity ?? 0.35))
  // 壁纸纵向焦点:按当前图片 URL 从 bgPositions 查其记忆的裁剪位置(缺省略偏上),供三处 cover 图层
  // (.app-bg-layer / .chat::before / .home-bg-layer)统一消费。见 schema.ts bgPositions 说明。
  const bgPos = a.bgPositions?.[a.bgImage] ?? DEFAULT_BG_POSITION
  root.style.setProperty('--app-bg-pos', `${bgPos}%`)
  // 首页背景:独立开关 + 独立图/不透明度。仅 HomeView 的 .home-bg-layer 消费,故只在首页生效,
  // 且盖过 'app' 范围背景(它在 #view-home 内、天然在最底层 .app-bg-layer 之上)。
  const homeBgOn = !!a.homeBgImage && !!a.homeBgOn
  root.setAttribute('data-home-bg', homeBgOn ? 'on' : 'off')
  root.style.setProperty('--home-bg-image', a.homeBgImage ? `url("${a.homeBgImage}")` : 'none')
  root.style.setProperty('--home-bg-opacity', String(a.homeBgOpacity ?? 0.35))
  const homeBgPos = a.bgPositions?.[a.homeBgImage] ?? DEFAULT_BG_POSITION
  root.style.setProperty('--home-bg-pos', `${homeBgPos}%`)
}
