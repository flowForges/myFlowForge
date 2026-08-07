import type { Appearance } from '@shared/types'

// ============================================================================
// 壁纸自动配色:从壁纸像素里取「两个色相角」,其余全部照抄 tokens.css 里已验证过的明度阶梯。
//
// 这是整套设计的安全底线 —— 壁纸只被允许提供 hueBg / hueAccent(和一个夹紧过的 tint 彩度),
// 明度与对比层次一律来自 tokens.css 的 dark/light + midnight/sepia/forest 阶梯(那几套的注释写得很清楚:
// 「明度沿用 dark(经过验证的对比层次),只把色相换掉 + 加克制的 tint」)。所以壁纸再脏再乱,也生不出
// 看不清字的界面 —— 这正是主题皮肤那轮反复踩 --muted/--faint/--surface 对比度坑之后得到的教训。
//
// 本文件是纯函数(不碰 DOM / canvas / React),取样落在 wallpaperSample.ts,方便直接喂合成像素做单测。
// ============================================================================

export interface WallpaperPalette {
  /** 按壁纸整体感知明度判定的基调,决定 data-theme 与用哪套阶梯。 */
  base: 'light' | 'dark'
  /** 主调色相(0..360):面积最大的有彩色区域,用来给中性色染一点温度。 */
  hueBg: number
  /** 中性色的 tint 彩度,已夹在 TINT_MIN..TINT_MAX;灰度壁纸为 0(纯中性)。 */
  chromaBg: number
  /** 点缀色色相:壁纸里面积小但最鲜艳的那抹色(夕阳的橙、霓虹的青)。null = 壁纸没有可用彩色,保留用户原强调色。 */
  hueAccent: number | null
}

// ---------------------------------------------------------------------------
// 调参区。这些阈值是要拿真壁纸一张张过眼睛才能定死的,集中放这里方便一轮轮改。
// ---------------------------------------------------------------------------
export const TUNING = {
  /** 取样边长:壁纸被降采样到 SAMPLE×SAMPLE 再统计(浏览器顺手做的降采样,已隐含均值滤波)。 */
  SAMPLE: 64,
  /** 感知明度(OKLab L)均值高于此判浅色基调。 */
  LIGHT_L: 0.62,
  /** 中性色 tint 彩度的夹紧区间。上界是关键:深色皮肤那轮的教训是 surface 一旦「又暗又饱和」就像重色板。 */
  TINT_MIN: 0.012,
  TINT_MAX: 0.026,
  /** 壁纸平均彩度 → tint 彩度的换算系数(再夹进上面的区间)。 */
  TINT_FROM_CHROMA: 0.25,
  /** 色相直方图桶数(36 桶 = 每桶 10°)。 */
  HUE_BUCKETS: 36,
  /**
   * 点缀色必须与主调色相至少相差这么多度。OKLCH 里 30° 只是相邻色调(青 vs 青绿),不足以读成「另一抹色」,
   * 结果是整窗一片同色系的浑浊 —— 真机上「青蓝天空壁纸出橄榄绿」就有这一份。45° 起才是肉眼可辨的第二色。
   */
  ACCENT_MIN_HUE_GAP: 45,
  /**
   * 点缀色所在桶在「有彩色像素」中的最小面积占比。1.5% 太宽松:实测一张 36% 面积是青蓝天空的壁纸,
   * accent 被 1.9% 的金色枝叶抢走,整个 App 变橄榄。3% 才算「画面里真的有这抹色」。
   */
  ACCENT_MIN_SHARE: 0.03,
  /** 像素彩度达到多少才算「有彩色」(参与色相投票与占比统计)。 */
  COLORFUL_MIN_C: 0.04,
  /** 有彩色像素占比低于此 → 判为灰度/极灰壁纸,出纯中性皮肤并保留用户原强调色。 */
  COLORFUL_MIN_SHARE: 0.02,
  /** 像素 alpha 低于此忽略(透明 png 的空白区不该参与统计)。 */
  MIN_ALPHA: 128,
} as const

// ---------------------------------------------------------------------------
// sRGB → OKLab/OKLCH(Björn Ottosson 的定值矩阵)。
// 为什么必须转:在 RGB 里没法回答「哪个更鲜艳」「这俩色相像不像」;在 OKLCH 里 C 就是鲜艳度、H 就是色相。
// ---------------------------------------------------------------------------
function srgbToLinear(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function srgbToOklch(r: number, g: number, b: number): { L: number; C: number; h: number } {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  const C = Math.hypot(a, bb)
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { L, C, h }
}

/** 两个色相角在色环上的最短距离(0..180)。 */
export function hueGap(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360)
  return d > 180 ? 360 - d : d
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ---------------------------------------------------------------------------
// 色域可达性。同一个「明度 + 彩度」组合,不同色相能不能真的画出来差别极大:浅色底的 accent 明度是 56%,
// 蓝色在那个明度轻松吃满 0.16 彩度,而黄/金在 56% 上只能到 ~0.11 —— 硬要 0.16 只会被浏览器压回去,
// 出来就是一坨橄榄泥(真机实测:要 0.16 得到 0.117)。
// 所以取色时必须知道「这个色相在目标明度下到底能多鲜艳」,把上不去的色相判负,而不是选了再让浏览器压。
// ---------------------------------------------------------------------------
function oklchToLinearRgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h), b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}

/** 给定明度与色相,sRGB 里能达到的最大彩度(二分,~24 次迭代足够精确到 1e-7)。 */
export function maxChromaAt(L: number, hDeg: number): number {
  let lo = 0, hi = 0.4
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (oklchToLinearRgb(L, mid, hDeg).every(v => v >= -0.0005 && v <= 1.0005)) lo = mid
    else hi = mid
  }
  return lo
}

// 强调色波段:和 tokens.css 里 12 个预设强调色完全同一档(深色 L72/C.15、浅色 L56/C.16),
// 所以壁纸取出来的 accent 天然和内置强调色一样安全 —— 只有色相是新的。
const ACCENT_BAND = {
  dark: { L: 72, C: 0.15, runL: 74, runC: 0.14, dimA: 0.16, on: 'oklch(15% 0.02 %H)' },
  light: { L: 56, C: 0.16, runL: 56, runC: 0.15, dimA: 0.12, on: 'oklch(99% 0 0)' },
} as const

/** 某个色相当 accent 时实际能拿到的彩度(被色域卡住就是卡住后的值)。用于取色打分与最终产出。 */
function reachableAccentChroma(base: 'light' | 'dark', hue: number): number {
  const band = ACCENT_BAND[base]
  return Math.min(band.C, maxChromaAt(band.L / 100, hue))
}

// ---------------------------------------------------------------------------
// 取色主函数。输入是 RGBA 像素数组(canvas.getImageData().data 的形状),输出两个色相角 + 基调。
// 全部是算术:平均、直方图、圆周均值 —— 没有任何图像识别。
// ---------------------------------------------------------------------------
export function extractPalette(pixels: ArrayLike<number>): WallpaperPalette | null {
  const n = Math.floor(pixels.length / 4)
  if (n <= 0) return null

  const N = TUNING.HUE_BUCKETS
  const span = 360 / N
  // 每桶:投票权重(Σ C²,灰像素几乎不投票)、有彩色像素数、Σ C、加权的 sin/cos(圆周均值用)、最大 C。
  const weight = new Float64Array(N)
  const count = new Float64Array(N)
  const sumC = new Float64Array(N)
  const sumSin = new Float64Array(N)
  const sumCos = new Float64Array(N)

  let sumL = 0, seen = 0, colorful = 0

  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (pixels[o + 3] < TUNING.MIN_ALPHA) continue
    const { L, C, h } = srgbToOklch(pixels[o], pixels[o + 1], pixels[o + 2])
    sumL += L
    seen++
    if (C < TUNING.COLORFUL_MIN_C) continue
    colorful++
    const b = Math.min(N - 1, Math.floor(h / span))
    const w = C * C
    const rad = (h * Math.PI) / 180
    weight[b] += w
    count[b] += 1
    sumC[b] += C
    sumSin[b] += Math.sin(rad) * w
    sumCos[b] += Math.cos(rad) * w
  }

  if (seen === 0) return null
  const base: 'light' | 'dark' = sumL / seen > TUNING.LIGHT_L ? 'light' : 'dark'

  // 灰度/极灰壁纸:出纯中性皮肤,强调色留给用户原本的设置(别拿噪点的色相乱染)。
  if (colorful / seen < TUNING.COLORFUL_MIN_SHARE) {
    return { base, hueBg: 0, chromaBg: 0, hueAccent: null }
  }

  const bucketHue = (b: number) => ((Math.atan2(sumSin[b], sumCos[b]) * 180) / Math.PI + 360) % 360

  // 主调 = 票数(Σ C²)最高的桶。
  let dom = 0
  for (let b = 1; b < N; b++) if (weight[b] > weight[dom]) dom = b
  const hueBg = bucketHue(dom)
  const chromaBg = clamp((sumC[dom] / count[dom]) * TUNING.TINT_FROM_CHROMA, TUNING.TINT_MIN, TUNING.TINT_MAX)

  // 点缀色 = 离主调够远、面积够大的桶里「贡献度」最高的那个。
  // 打分 = 面积占比 × 该色相当 accent 时真正可达的彩度。两个因子都是必须的:
  //   · 只看最高彩度 → 1.9% 的金色枝叶能压过 36% 的青蓝天空(真机上就是这么变橄榄的)
  //   · 不看可达彩度 → 选中在目标明度下必然发浑的暖色相,再鲜艳的金色也会被压成泥
  // 占比分母用「有彩色像素数」,否则灰调壁纸里每个桶的占比都小到过不了门槛。
  let acc = -1, accScore = 0
  for (let b = 0; b < N; b++) {
    const share = count[b] / colorful
    if (share < TUNING.ACCENT_MIN_SHARE) continue
    const hue = bucketHue(b)
    if (hueGap(hue, hueBg) < TUNING.ACCENT_MIN_HUE_GAP) continue
    const score = share * reachableAccentChroma(base, hue)
    if (score > accScore) { accScore = score; acc = b }
  }
  // 找不到第二抹色 → 退化成单色相(accent 用主调色相,靠明度/彩度拉开)。
  const hueAccent = acc < 0 ? hueBg : bucketHue(acc)

  return { base, hueBg, chromaBg, hueAccent }
}

// ---------------------------------------------------------------------------
// 阶梯 → CSS 变量。明度(%)与彩度倍率照抄 tokens.css:
//   dark  阶梯来自 [data-theme="midnight"/"sepia"/"forest"](它们本身就是「换色相 + 克制 tint」的成品)
//   light 阶梯来自 [data-theme="light"](浅色只加很轻的 tint,避免整窗发黄/发蓝)
// 彩度倍率 = 该 token 在原阶梯里的 chroma ÷ 该阶梯的基准 tint。
// ---------------------------------------------------------------------------
type Rung = [prop: string, lightness: number, chromaMul: number]

const DARK_LADDER: Rung[] = [
  ['--bg', 20, 1.00], ['--bg-2', 23, 1.09], ['--sidebar', 17, 1.18],
  ['--surface', 26, 1.09], ['--surface-2', 30, 1.18],
  ['--fg', 95, 0.36], ['--fg-2', 82, 0.55], ['--muted', 64, 0.82], ['--faint', 50, 0.82],
]

const LIGHT_LADDER: Rung[] = [
  ['--bg', 98, 1.00], ['--bg-2', 96, 1.20], ['--sidebar', 95, 1.40],
  ['--surface', 99, 0.70], ['--surface-2', 96.5, 1.50],
  ['--fg', 24, 0.50], ['--fg-2', 34, 0.50], ['--muted', 50, 0.50], ['--faint', 62, 0.40],
]

// 边框不走实色阶梯,而是正文色的半透明版 —— 侧栏/检视区/标题栏/状态栏那几道接缝直接压在壁纸上,
// 实色边框在深色基调下就是几条刺眼的硬黑线(global.css:57-60 的原注释:read as harsh BLACK LINES)。
// 那条规则和 skins.css:153 都已这么处理,但内联变量优先级更高会把它们压掉,所以这里必须自己产出同款。
const BORDER_ALPHA = { '--border': 0.13, '--border-2': 0.22 } as const

// 毛玻璃三件套:取 bg / bg-2 / sidebar 同色,只加透明度(深色保持偏不透明,免得亮壁纸把 UI 冲淡成灰黄)。
const GLASS: Record<'dark' | 'light', { prop: string; from: string; alpha: number }[]> = {
  dark: [
    { prop: '--glass-window', from: '--bg', alpha: 0.85 },
    { prop: '--glass-panel', from: '--bg-2', alpha: 0.82 },
    { prop: '--glass-sidebar', from: '--sidebar', alpha: 0.82 },
  ],
  light: [
    { prop: '--glass-window', from: '--bg', alpha: 0.55 },
    { prop: '--glass-panel', from: '--bg-2', alpha: 0.50 },
    { prop: '--glass-sidebar', from: '--sidebar', alpha: 0.50 },
  ],
}

const num = (v: number, digits: number) => String(Number(v.toFixed(digits)))
const oklch = (L: number, C: number, h: number, alpha?: number) =>
  `oklch(${num(L, 2)}% ${num(C, 4)} ${num(h, 1)}${alpha == null ? '' : ` / ${alpha}`})`

/**
 * 一套调色板 → 要内联到 :root 的 CSS 变量。
 * hueAccent 为 null(灰度壁纸)时不产出 accent 四件套,把强调色交还给用户自己的设置。
 */
export function paletteVars(p: WallpaperPalette): Record<string, string> {
  const ladder = p.base === 'dark' ? DARK_LADDER : LIGHT_LADDER
  const vars: Record<string, string> = {}
  const rung = new Map<string, { L: number; C: number }>()
  for (const [prop, L, mul] of ladder) {
    const C = p.chromaBg * mul
    rung.set(prop, { L, C })
    vars[prop] = oklch(L, C, p.hueBg)
  }
  for (const g of GLASS[p.base]) {
    const r = rung.get(g.from)!
    vars[g.prop] = oklch(r.L, r.C, p.hueBg, g.alpha)
  }
  const fg = rung.get('--fg')!
  for (const [prop, alpha] of Object.entries(BORDER_ALPHA)) {
    vars[prop] = oklch(fg.L, fg.C, p.hueBg, alpha)
  }
  if (p.hueAccent != null) {
    const a = ACCENT_BAND[p.base]
    // 自己把彩度夹到该色相在该明度下真正可达的范围,而不是丢一个色域外的值让浏览器去压 ——
    // 压完的结果不可预测(实测色相不变但彩度掉三成),也会让 --accent-dim / --run 与 --accent 不同步。
    const accC = reachableAccentChroma(p.base, p.hueAccent)
    const runC = Math.min(a.runC, maxChromaAt(a.runL / 100, p.hueAccent))
    vars['--accent'] = oklch(a.L, accC, p.hueAccent)
    vars['--accent-dim'] = oklch(a.L, accC, p.hueAccent, a.dimA)
    vars['--run'] = oklch(a.runL, runC, p.hueAccent)
    vars['--on-accent'] = a.on.replace('%H', num(p.hueAccent, 1))
  }
  return vars
}

/** applyTheme 每次都要先清掉的一整套属性名(不管这轮产不产出),避免关掉开关后残留内联值。 */
export const PALETTE_PROPS: readonly string[] = [
  ...DARK_LADDER.map(([prop]) => prop),
  ...GLASS.dark.map(g => g.prop),
  ...Object.keys(BORDER_ALPHA),
  '--accent', '--accent-dim', '--run', '--on-accent',
]

/** 设置页那排色点预览:底 / 侧栏 / 强调 / 正文。 */
export function paletteSwatches(p: WallpaperPalette): string[] {
  const v = paletteVars(p)
  return [v['--bg'], v['--sidebar'], v['--accent'] ?? v['--surface-2'], v['--fg']]
}

/**
 * 这套外观该拿哪张图取色:优先应用/会话区背景图,其次首页背景图;都没有则返回 ''(开关置灰)。
 */
export function wallpaperSourceFor(a: Appearance | undefined): string {
  if (!a) return ''
  if (a.bgImage && a.bgScope && a.bgScope !== 'off') return a.bgImage
  if (a.homeBgImage && a.homeBgOn) return a.homeBgImage
  return ''
}
