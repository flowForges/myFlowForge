// 内嵌 HTML 片段的内联 style 净化 + 配色接管。
//
// 模型按提示词输出的片段是 100% 内联 style 的(禁 <style>/class/伪类),写死的又都是「白底黑字 + 少量
// 彩色强调」这套浅色假设。直接放行有两个问题:一是 position/z-index 这类属性能盖住整个 app 做点击劫持;
// 二是写死的颜色在深色皮肤/壁纸配色下要么瞎要么丑,而我们有 6 套皮肤 + 壁纸自动配色。
//
// 所以这里做两件事:
//   1) 属性白名单 —— 不在名单上的整条丢弃(是白名单不是黑名单:没列出的属性没有代码路径能出去)。
//   2) 颜色一律映射成 var(--token) —— 绝不输出算好的色值。
//
// ★ 第 2 条是硬约束,不是风格偏好:markdown.tsx 的 PARSE_CACHE 按「原文」缓存 ReactNode,主题切换不会让它
// 失效。一旦这里输出了具体色值,用户换皮肤/换壁纸后卡片会卡在旧配色,而且因为缓存命中,重进会话都刷不掉。
// 只输出 var(--x) 则皮肤和壁纸配色零成本自动跟随 —— 壁纸配色本来就是往这套 token 上写的。

import type { CSSProperties } from 'react'

// 任何值里出现这些 = 整条声明丢弃。url() 在 Electron 里是追踪信标 + 泄露出口 IP;expression()/javascript:
// 是老 IE 的执行面;@import 能拉外部样式表;反斜杠是 CSS 转义,用来绕过上面这些字面量匹配。
const DANGER = /url\s*\(|expression\s*\(|javascript\s*:|@import|\\/i

// 长度:px/em/rem/%/ch + 无单位 0/数字 + auto。刻意不收 vw/vh —— 视口单位能让一个卡片撑到整屏。
const LENGTH = /^(auto|0|[+-]?(\d+\.?\d*|\.\d+)(px|em|rem|%|ch)?)$/i
const isLengthList = (v: string): boolean => v.split(/\s+/).filter(Boolean).every(p => LENGTH.test(p))

// 关键字型属性:各自的合法取值集合。收得比 CSS 规范窄,够模型排版用就行。
const KEYWORDS: Record<string, Set<string>> = {
  display: new Set(['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'table', 'table-row', 'table-cell']),
  'flex-direction': new Set(['row', 'row-reverse', 'column', 'column-reverse']),
  'flex-wrap': new Set(['nowrap', 'wrap', 'wrap-reverse']),
  'align-items': new Set(['flex-start', 'flex-end', 'start', 'end', 'center', 'baseline', 'stretch']),
  'justify-content': new Set(['flex-start', 'flex-end', 'start', 'end', 'center', 'space-between', 'space-around', 'space-evenly']),
  'text-align': new Set(['left', 'right', 'center', 'justify', 'start', 'end']),
  'white-space': new Set(['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']),
  'overflow': new Set(['visible', 'hidden', 'auto', 'scroll', 'clip']),
  'overflow-x': new Set(['visible', 'hidden', 'auto', 'scroll', 'clip']),
  'overflow-y': new Set(['visible', 'hidden', 'auto', 'scroll', 'clip']),
  'vertical-align': new Set(['baseline', 'top', 'middle', 'bottom', 'sub', 'super', 'text-top', 'text-bottom']),
  'font-style': new Set(['normal', 'italic', 'oblique']),
  'text-decoration': new Set(['none', 'underline', 'line-through', 'overline']),
  'list-style': new Set(['none', 'disc', 'circle', 'square', 'decimal']),
  'list-style-type': new Set(['none', 'disc', 'circle', 'square', 'decimal']),
  'word-break': new Set(['normal', 'break-all', 'keep-all', 'break-word']),
  'box-sizing': new Set(['content-box', 'border-box']),
}

// 只吃长度(可多值,如 padding: 8px 12px)的属性。
const LENGTH_PROPS = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap', 'border-radius',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'letter-spacing', 'border-width', 'flex-basis', 'text-indent',
])

// 颜色属性 → 语义角色。角色决定同一个灰度值落到哪条 token 阶梯上。
const COLOR_ROLE: Record<string, 'fg' | 'bg' | 'border'> = {
  'color': 'fg',
  'background-color': 'bg',
  'border-color': 'border',
  'border-top-color': 'border',
  'border-right-color': 'border',
  'border-bottom-color': 'border',
  'border-left-color': 'border',
}

const BORDER_SHORTHAND = new Set(['border', 'border-top', 'border-right', 'border-bottom', 'border-left'])
const BORDER_STYLE = new Set(['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'])

// 原样透传即可、且本身不含字面颜色的关键字。
const COLOR_PASSTHROUGH = new Set(['transparent', 'inherit', 'currentcolor', 'initial', 'unset'])

// ---- 颜色解析 ---------------------------------------------------------------

// 只认模型实际会写的那几种写法。认不出来 = 整条声明丢弃(fail closed),不猜。
const NAMED: Record<string, [number, number, number]> = {
  white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], orange: [255, 165, 0], purple: [128, 0, 128],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], teal: [0, 128, 128],
  navy: [0, 0, 128], maroon: [128, 0, 0], olive: [128, 128, 0], lime: [0, 255, 0],
  aqua: [0, 255, 255], cyan: [0, 255, 255], fuchsia: [255, 0, 255], magenta: [255, 0, 255],
  pink: [255, 192, 203], brown: [165, 42, 42], gold: [255, 215, 0], indigo: [75, 0, 130],
  violet: [238, 130, 238], crimson: [220, 20, 60], salmon: [250, 128, 114],
}

export function parseColor(raw: string): [number, number, number] | null {
  const v = raw.trim().toLowerCase()
  const named = NAMED[v]
  if (named) return named
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
    if (h.length === 6 || h.length === 8) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    return null
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(v)
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3)
    if (parts.length < 3) return null
    const nums = parts.map(p => p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p))
    if (nums.some(n => !Number.isFinite(n))) return null
    return [nums[0], nums[1], nums[2]]
  }
  return null
}

// sRGB → OKLCH。取 L(明度 0–1)/C(彩度)/H(色相角) 三个量:L 决定灰度落在哪一阶,C 判断是不是「有颜色」,
// H 决定彩色归到哪个语义 token。用 OKLCH 而不是 HSL,是因为它的明度是感知均匀的 —— 和 tokens.css 里那套
// 本来就用 oklch() 写的阶梯同一把尺子。
export function toOklch(r: number, g: number, b: number): { L: number; C: number; H: number } {
  const lin = (c: number): number => {
    const x = Math.min(255, Math.max(0, c)) / 255
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  const R = lin(r), G = lin(g), B = lin(b)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  const C = Math.sqrt(A * A + Bb * Bb)
  const H = ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360
  return { L, C, H }
}

// 有彩色的阈值。低于这个就是黑白灰,走中性阶梯。
const CHROMA_MIN = 0.05

// 彩色 → 语义 token。判不准的一律塌到 --accent:宁可单调,也绝不把强调框映射成警告框(语义反转比
// 配色单调糟得多)。
// 分界点是拿真实色值量出来的,不是照着色轮猜的 —— OKLCH 的色相角和 HSL 差很远(纯黄在 OKLCH 是 110°
// 不是 60°)。实测:crimson 20 / red 29 / amber 58 / orange 71 / gold 95 / yellow 110 / green 143 /
// emerald 162 / teal 195 / blue 263 / violet 293 / magenta 328。
function chromaticToken(H: number): string {
  if (H >= 345 || H < 45) return '--err'      // 粉红 7、crimson 20、红 29
  if (H < 125) return '--warn'                // amber 58、橙 71、gold 95、黄 110
  if (H < 190) return '--ok'                  // 绿 143、emerald 162
  return '--accent'                           // 青 195、蓝 263、紫 293、品红 328
}

// 黑白灰 → 中性阶梯。模型写死的灰度是「浅色假设」(白底黑字),这里按浅色语义读入、输出到语义 token,
// 于是深色皮肤下自动翻成深底浅字 —— 这正是配色接管要的效果。
function neutralToken(L: number, role: 'fg' | 'bg' | 'border'): string {
  if (role === 'border') return '--border'
  if (role === 'bg') {
    if (L >= 0.97) return '--surface'
    if (L >= 0.90) return '--bg-2'
    if (L >= 0.5) return '--surface-2'
    return '--bg'
  }
  if (L <= 0.35) return '--fg'
  if (L <= 0.6) return '--fg-2'
  return '--muted'
}

// 一个颜色字面量 → `var(--token)`。认不出的颜色返回 null(调用方整条丢弃)。
export function mapColor(raw: string, role: 'fg' | 'bg' | 'border'): string | null {
  const v = raw.trim().toLowerCase()
  if (COLOR_PASSTHROUGH.has(v)) return v === 'currentcolor' ? 'currentColor' : v
  const rgb = parseColor(v)
  if (!rgb) return null
  const { L, C, H } = toOklch(rgb[0], rgb[1], rgb[2])
  return `var(${C >= CHROMA_MIN ? chromaticToken(H) : neutralToken(L, role)})`
}

// ---- 单条声明 ---------------------------------------------------------------

const camel = (prop: string): string => prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

// font-size 允许 px,但夹住上限 —— 一个 200px 的标题会把消息流撑得没法看。
const FONT_SIZE_MAX_PX = 32

// ---- 几何量化 ---------------------------------------------------------------
//
// ★★颜色早就一律映射成 var(--token) 了,几何却一直原样放行 —— 这就是「框有时候有点乱」
//  (用户 2026-09-07 原话)的机械原因:模型这次写 6px 圆角、下次 14px,这张卡 1px 边、那张 3px,
//  内边距 10 / 16 / 24,同一段对话里两张卡对不齐,而且都跟 app 自己的框对不上。
//  所以这里用**和颜色一模一样的招**:吸附到阶梯,绝不原样输出模型算出来的值。
// ★理由也一模一样(见文件顶上第 2 条):markdown.tsx 的 PARSE_CACHE 按原文缓存 ReactNode,
//  输出算好的值会被永久缓存住,换皮肤/换字号都刷不掉。
// ★代价是模型精心排的 13px 内边距会变成 12px。这正是要的 —— 一致性比模型的即兴品味值钱。
//
// 只量化**节奏类**的量(圆角/边宽/间距/字号)。宽高**不动**:那是布局意图(一个 37px 的图标位、
// 一个 50% 的两栏),吸附它只会把版排坏。

/** 圆角四档:无 / 小 / 卡片 / 药丸。
 *  ★★这四个数**就是 tokens.css 里的 --r-sm(7) 和 --r(9)** —— 会话区自己的框(代码块、附件 chip、
 *   子代理卡)用的也是它们。别把这里改成一套「更好看」的数:模型的卡片和我们的框差 1–2px 时,
 *   人眼说不出哪儿怪,整屏就是不齐,而这正是当初要做量化的原因。改这里要连着 chat.css 一起改。 */
const RADIUS_LADDER = [0, 7, 9, 999]
/** 间距按 8pt 阶梯。 */
const SPACE_LADDER = [0, 2, 4, 8, 12, 16, 24, 32, 48]   // 2 这一档是给行内小标签留的(padding:2px 6px)
/** 字号阶梯,和会话区正文那套对齐。单位是 em(相对正文),所以会跟着「会话区字号」设置走。 */
const FONT_EM_LADDER = [0.78, 0.86, 1, 1.18, 1.36, 1.7, 2.3]
/** 卡片里的 1em = 会话区正文字号。模型写的 px 先按这个换算成 em,再吸附。 */
const BASE_FONT_PX = 14

/** 取阶梯上离 n 最近的一档。★正好卡在两档中间时取**小**的那档(比较用严格 <,先到先得):
 *  规则单一、没有例外,而且往小走只会让版面更紧,不会把卡片撑开。 */
function snap(n: number, ladder: number[]): number {
  let best = ladder[0]
  for (const step of ladder) if (Math.abs(step - n) < Math.abs(best - n)) best = step
  return best
}

/** 一个长度值 → 量化后的长度值。只动 px 和无单位 0;em/rem/% 本来就跟着排版走,原样放行。 */
function snapLength(v: string, ladder: number[]): string {
  const t = v.trim()
  if (t === '0') return '0'
  const m = /^([\d.]+)px$/i.exec(t)
  if (!m) return t
  const snapped = snap(parseFloat(m[1]), ladder)
  return snapped === 0 ? '0' : `${snapped}px`
}

/** 多值(`padding: 10px 14px`)逐段量化 —— 上下和左右各有各的节奏,不能只看第一段。 */
const snapLengthList = (v: string, ladder: number[]): string =>
  v.trim().split(/\s+/).filter(Boolean).map(p => snapLength(p, ladder)).join(' ')

/** 属性 → 该用哪把尺子。不在表里的长度属性(width/height/flex-basis…)不量化。 */
function ladderFor(p: string): number[] | null {
  if (p === 'border-radius') return RADIUS_LADDER
  if (p === 'border-width' || p.endsWith('-width') && p.startsWith('border-')) return [0, 1]
  if (/^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(p)) return SPACE_LADDER
  return null
}

/** 百分比圆角(`border-radius: 50%` 画圆)按药丸处理 —— 它表达的就是「最圆」。 */
function snapRadius(v: string): string {
  return /%$/.test(v.trim()) ? '999px' : snapLengthList(v, RADIUS_LADDER)
}

/** px 字号 → 吸附后的 em。★输出 em 是关键:写死 px 的话,用户调「会话区字号」时卡片纹丝不动。 */
function snapFontSize(v: string): string {
  const t = v.trim()
  const m = /^([\d.]+)px$/i.exec(t)
  if (!m) return t
  const em = Math.min(parseFloat(m[1]), FONT_SIZE_MAX_PX) / BASE_FONT_PX
  return `${snap(em, FONT_EM_LADDER)}em`
}


function mapDeclaration(prop: string, value: string): [string, string] | null {
  const p = prop.trim().toLowerCase()
  const v = value.trim()
  if (!p || !v || DANGER.test(v) || DANGER.test(p)) return null

  const role = COLOR_ROLE[p]
  if (role) {
    const mapped = mapColor(v, role)
    return mapped ? [camel(p), mapped] : null
  }

  // background 简写:只接「纯颜色」那种。带渐变/图片的整条丢(而且多半已经被 DANGER 的 url() 拦掉)。
  if (p === 'background') {
    const mapped = mapColor(v, 'bg')
    return mapped ? ['background', mapped] : null
  }

  // border 简写:拆成 宽度 / 线型 / 颜色 三段分别处理,颜色那段换成 var()。缺哪段就不输出哪段。
  if (BORDER_SHORTHAND.has(p)) {
    const parts = v.split(/\s+/).filter(Boolean)
    if (v.toLowerCase() === 'none' || v === '0') return [camel(p), 'none']
    const out: string[] = []
    for (const part of parts) {
      // ★宽度段一律压成 1px(0/none 除外) —— 粗细不一是「框乱」最直接的来源。
      if (LENGTH.test(part)) { out.push(snapLength(part, [0, 1])); continue }
      if (BORDER_STYLE.has(part.toLowerCase())) { out.push(part.toLowerCase()); continue }
      const mapped = mapColor(part, 'border')
      if (!mapped) return null   // 认不出的段 = 整条丢弃,不猜
      out.push(mapped)
    }
    return out.length ? [camel(p), out.join(' ')] : null
  }

  if (p === 'font-size') {
    if (!LENGTH.test(v)) return null
    return ['fontSize', snapFontSize(v)]
  }

  if (p === 'border-radius') return isLengthList(v) || /%$/.test(v.trim()) ? ['borderRadius', snapRadius(v)] : null
  if (LENGTH_PROPS.has(p)) {
    if (!isLengthList(v)) return null
    const ladder = ladderFor(p)
    return [camel(p), ladder ? snapLengthList(v, ladder) : v]
  }

  const kw = KEYWORDS[p]
  if (kw) return kw.has(v.toLowerCase()) ? [camel(p), v.toLowerCase()] : null

  // font-weight:数值或 normal/bold。
  if (p === 'font-weight') return /^([1-9]00|normal|bold|bolder|lighter)$/i.test(v) ? ['fontWeight', v.toLowerCase()] : null
  // line-height:无单位倍数或长度。
  if (p === 'line-height') return /^[\d.]+$/.test(v) || LENGTH.test(v) ? ['lineHeight', v] : null
  // flex / flex-grow / flex-shrink:纯数字或 flex 的常见简写。
  if (p === 'flex' || p === 'flex-grow' || p === 'flex-shrink') return /^[\d.\s]+$|^(auto|none|initial)$/i.test(v) ? [camel(p), v] : null
  // grid 轨道定义:允许 repeat()/minmax()/fr/长度。DANGER 已经挡掉 url()/expression(),这里只再收窄字符集。
  if (p === 'grid-template-columns' || p === 'grid-template-rows' || p === 'grid-column' || p === 'grid-row') {
    return /^[a-z0-9%.,()\s/-]+$/i.test(v) ? [camel(p), v] : null
  }

  return null   // 不在白名单上 —— 没有代码路径能让它出去
}

// ---- 入口 -------------------------------------------------------------------

/**
 * 把一段内联 style 字符串映射成安全的 React CSSProperties。
 * 不在白名单上的属性、认不出的值、任何带 url()/expression()/javascript: 的声明,一律丢弃。
 * 输出里的颜色**只会**是 `var(--token)` 或 transparent/inherit/currentColor —— 永远不含字面色值。
 */
export function mapInlineStyle(raw: string): CSSProperties {
  const out: Record<string, string> = {}
  if (!raw) return out as CSSProperties
  for (const decl of raw.split(';')) {
    const idx = decl.indexOf(':')
    if (idx < 0) continue
    const mapped = mapDeclaration(decl.slice(0, idx), decl.slice(idx + 1))
    if (mapped) out[mapped[0]] = mapped[1]
  }
  return out as CSSProperties
}
