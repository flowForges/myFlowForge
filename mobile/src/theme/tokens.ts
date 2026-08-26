/**
 * 配色令牌 —— 单一来源是手机端原型的设计层 `screens/d.css`(方向 D,已定稿)。
 *
 * RN 不认 `oklch()` 也不认 `color-mix()`,所以这里存的是换算后的 sRGB。
 * ★换算是**算出来的不是调出来的**:oklch→oklab→线性 sRGB→sRGB 全程按公式走,
 *  并且拿真 Chrome(canvas 取像素)逐个核对过,误差 ≤1/255。
 *  以后原型改了色,改这里的源 oklch 串再重跑换算,别肉眼凑近似值。
 */
export type Palette = {
  bg: string
  bg2: string
  surface: string
  surface2: string
  fg: string
  fg2: string
  muted: string
  faint: string
  border: string
  border2: string
  accent: string
  onAccent: string
  gate: string
  onGate: string
  ok: string
  warn: string
  err: string
  add: string
  del: string
  synKw: string
  synSt: string
  synCm: string
  synFn: string
  synTy: string
  accentDim: string
  gateDim: string
  gateBorder: string
  gateRowBg: string
  pillGateBorder: string
  pillRunBorder: string
  pillErrBorder: string
  pillAccBorder: string
  onGate12: string
  onGate14: string
  permAutoBorder: string
  permReadonlyBorder: string
  permFullBorder: string
  addBg: string
  delBg: string
  youBorder: string
  bannerOffBg: string
  scrim: string
  /** `.tool.running` 的边框 —— d.css 的 `color-mix(in oklab, var(--accent) 38%, var(--border))`。 */
  toolRunBorder: string
  /** 阴影颜色(贴底浮起元素——比如定位气泡——的投影用,不是 surface 色)。不透明,配合 RN 的 shadowOpacity 单独控制透明度。 */
  shadow: string
}

/** 深色。数值由 d.css 的 oklch 换算而来(oklch→oklab→sRGB),不是手调的近似值。 */
export const DARK: Palette = {
  bg: '#121417',
  bg2: '#181b1f',
  surface: '#1e2125',
  surface2: '#282c31',
  fg: '#edeef1',
  fg2: '#c4c7cc',
  muted: '#8b8f95',
  faint: '#606369',
  border: '#26292d',
  border2: '#3a3d42',
  accent: '#6d9df5',
  onAccent: '#0b0f18',
  gate: '#fab048',
  onGate: '#2e1b01',
  ok: '#66c189',
  warn: '#fab048',
  err: '#f2716a',
  add: '#66c189',
  del: '#f2716a',
  synKw: '#c49bf3',
  synSt: '#73c881',
  synCm: '#737b86',
  synFn: '#6bbef2',
  synTy: '#66d2ce',
  accentDim: 'rgba(109, 157, 245, 0.16)',
  gateDim: 'rgba(250, 176, 72, 0.14)',
  gateBorder: 'rgba(250, 176, 72, 0.58)',
  gateRowBg: '#2b2a2a',
  pillGateBorder: 'rgba(250, 176, 72, 0.48)',
  pillRunBorder: 'rgba(102, 193, 137, 0.42)',
  pillErrBorder: 'rgba(242, 113, 106, 0.45)',
  pillAccBorder: 'rgba(109, 157, 245, 0.45)',
  onGate12: 'rgba(46, 27, 1, 0.12)',
  onGate14: 'rgba(46, 27, 1, 0.14)',
  permAutoBorder: 'rgba(109, 157, 245, 0.45)',
  permReadonlyBorder: 'rgba(102, 193, 137, 0.45)',
  permFullBorder: 'rgba(242, 113, 106, 0.5)',
  addBg: 'rgba(102, 193, 137, 0.14)',
  delBg: 'rgba(242, 113, 106, 0.14)',
  youBorder: 'rgba(109, 157, 245, 0.34)',
  bannerOffBg: '#312224',
  scrim: 'rgba(0, 0, 0, 0.44)',
  toolRunBorder: '#405373',
  shadow: '#000000',
}

/** 浅色。 */
export const LIGHT: Palette = {
  bg: '#f5f7f9',
  bg2: '#eceff2',
  surface: '#ffffff',
  surface2: '#eff2f6',
  fg: '#171b21',
  fg2: '#32363c',
  muted: '#5c6167',
  faint: '#82868c',
  border: '#dbdee2',
  border2: '#c7cbd0',
  accent: '#2c58bf',
  onAccent: '#fcfcfc',
  gate: '#c46d00',
  onGate: '#fcfcfc',
  ok: '#007e46',
  warn: '#b36300',
  err: '#c13234',
  add: '#007840',
  del: '#c13234',
  synKw: '#7530ae',
  synSt: '#006921',
  synCm: '#79818c',
  synFn: '#005baf',
  synTy: '#006768',
  accentDim: 'rgba(44, 88, 191, 0.1)',
  gateDim: 'rgba(196, 109, 0, 0.12)',
  gateBorder: 'rgba(196, 109, 0, 0.58)',
  gateRowBg: '#fcf5ef',
  pillGateBorder: 'rgba(196, 109, 0, 0.48)',
  pillRunBorder: 'rgba(0, 126, 70, 0.42)',
  pillErrBorder: 'rgba(193, 50, 52, 0.45)',
  pillAccBorder: 'rgba(44, 88, 191, 0.45)',
  onGate12: 'rgba(252, 252, 252, 0.12)',
  onGate14: 'rgba(252, 252, 252, 0.14)',
  permAutoBorder: 'rgba(44, 88, 191, 0.45)',
  permReadonlyBorder: 'rgba(0, 126, 70, 0.45)',
  permFullBorder: 'rgba(193, 50, 52, 0.5)',
  addBg: 'rgba(0, 120, 64, 0.14)',
  delBg: 'rgba(193, 50, 52, 0.14)',
  youBorder: 'rgba(44, 88, 191, 0.34)',
  bannerOffBg: '#f1d9d9',
  scrim: 'rgba(0, 0, 0, 0.44)',
  toolRunBorder: '#96acd8',
  shadow: '#242e3d',
}

export type ThemeName = 'dark' | 'light'
export const PALETTES: Record<ThemeName, Palette> = { dark: DARK, light: LIGHT }

/** 字体栈。原型只用 Body + Mono 两种(数据密集界面,桌面端也是这么做的)。 */
export const FONT = {
  mono: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace',
} as const

/** 圆角尺度:控件 9–11,卡片 13–18。原型有意不用大圆角 —— 界面偏工具而非消费品。 */
export const RADIUS = { chip: 9, ctl: 11, btn: 12, field: 12, card: 13, panel: 14, gate: 16, sheet: 20 } as const
