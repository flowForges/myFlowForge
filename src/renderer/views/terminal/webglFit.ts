/**
 * 「这块屏 + 这个字号,能不能用 GPU 渲染器」。
 *
 * ★★xterm 的 WebGL 渲染器是把一个格子的**设备像素宽度向下取整**之后再画的
 *  (`WebglRenderer._updateDimensions`:`device.char.width = Math.floor(charWidth * dpr)`,
 *  然后 `css.cell.width = device.cell.width / dpr` 反推回去)。也就是说,只有
 *  `charWidth * dpr` 本身几乎正好是整数时,格子才装得下这个字形本来的宽度;否则每个字都被塞进
 *  一个比它自己还窄的格子里,笔画溢到隔壁去 —— 而擦掉一个字时隔壁那点溢出的笔画不会被重画。
 *  用户看到的就是「git commit 打出来变成 git coommit」「退格删到 g 那个 g 一直在,再打就成了 ggit」。
 *
 * ★★为什么原来那道闸门(`Number.isInteger(devicePixelRatio)`)不够:它检查的**不是渲染器真正
 *  依赖的那个数**。拿本仓默认的终端字体量一下(MesloLGS NF,advance = 0.60205 em,字号 12.5):
 *
 *    | 屏幕        | charWidth | ×dpr    | 取整 | 溢出(设备像素) |
 *    |------------|-----------|---------|-----|---------------|
 *    | Retina 2×   | 7.5256    | 15.0513 | 15  | 0.05  ← 看不出来,GPU 照用 |
 *    | 普通 1×     | 7.5256    | 7.5256  | 7   | 0.53  ← 7% 的挤压,就是这个 bug |
 *    | Retina 2×,字号 14 | 8.4287 | 16.8574 | 16 | 0.86 |
 *
 *  1× 屏幕的 dpr **正好是整数 1**,老闸门直接放行 —— 偏偏那是误差最大的一档。而开发机是 2× 屏,
 *  误差 0.05,所以这个 bug 在开发机上永远复现不出来(2026-09-08 用户第三次报,才量出这张表)。
 *
 * ★新判据严格强于老判据:dpr 是分数时(窗口缩放 / Windows 125%)`charWidth * dpr` 几乎不可能是整数,
 *  照样回落 DOM 渲染器;而「dpr 是分数但乘出来正好是整数」的那种情况本来就是安全的,现在也能用上 GPU。
 */

/**
 * 允许的溢出上限,单位是**设备像素**。
 *
 * 0.05 是实测「一直好用」的那一档(Retina + 默认字号),0.43 起就是用户报的那个坏掉的样子。
 * 取 0.2:比噪声大得多,又比任何一档坏样本小得多。★不是相对误差 —— 会不会看出来,取决于能溢出去
 * 多少**墨**,那是个绝对量。
 */
export const MAX_CELL_OVERHANG = 0.2

/**
 * `charWidth` 要用**渲染时真正生效的那个字体**量出来的值(xterm 自己用
 * `canvas.measureText('W').width`,见 CharSizeService 的 TextMetricsMeasureStrategy),
 * 不能按字号猜:用户配的字体栈里第一个字体没装,浏览器会回落到下一个,advance 就变了。
 *
 * 量不出来(拿不到 2d context)一律返回 false —— **宁可慢,不可画错**。
 */
export function webglCellFits(charWidth: number | null | undefined, dpr: number, limit = MAX_CELL_OVERHANG): boolean {
  if (charWidth == null || !Number.isFinite(charWidth) || charWidth <= 0) return false
  if (!Number.isFinite(dpr) || dpr <= 0) return false
  const device = charWidth * dpr
  return device - Math.floor(device) < limit
}

/** 按 xterm 量字宽的同一种办法量一次(同一个字体串、同一个 'W')。拿不到 canvas 就返回 null。 */
export function measureCharWidth(fontFamily: string, fontSize: number): number | null {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    ctx.font = `${fontSize}px ${fontFamily}`
    const w = ctx.measureText('W').width
    return Number.isFinite(w) && w > 0 ? w : null
  } catch {
    return null
  }
}
