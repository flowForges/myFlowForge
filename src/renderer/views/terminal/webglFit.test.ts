import { describe, it, expect } from 'vitest'
import { webglCellFits, MAX_CELL_OVERHANG } from './webglFit'

/**
 * 判据钉的是**渲染器真正做的那件事**:`Math.floor(charWidth * dpr)`。
 *
 * 下面这些 charWidth 不是编的,是从字体文件里量出来的:
 *   · MesloLGS NF Regular:unitsPerEm 2048、advance 1233 ⇒ 0.60205 em
 *     → 字号 12.5 ⇒ 7.5256px;字号 14 ⇒ 8.4287px
 * 本仓默认终端字体就是它,默认字号 12.5(config/schema.ts)。
 */
const MESLO = (size: number) => size * 1233 / 2048

describe('webglCellFits —— GPU 渲染器只在格子装得下字形时才用', () => {
  it('★★普通 1× 屏 + 默认字号:7.5256 → 取整成 7,溢出 0.53 设备像素 ⇒ 不许用 GPU', () => {
    // 用户 2026-09-08 报的就是这一档:「git commit 显示成 git coommit」「删到 g 那个 g 一直在」。
    expect(webglCellFits(MESLO(12.5), 1)).toBe(false)
  })

  it('★Retina 2× + 默认字号:15.0513 → 溢出 0.05,肉眼无差 ⇒ 照旧用 GPU', () => {
    // 这一档必须保住:开发机就是它,一直是好的,而 GPU 渲染器是为了 p10k 那种狂重画的提示符加的。
    expect(webglCellFits(MESLO(12.5), 2)).toBe(true)
  })

  it('★★老判据(dpr 是不是整数)在 1× 上会放行 —— 新旧判据必须在这一档上分道扬镳', () => {
    // 这条是整个修复的意义所在:dpr=1 是整数,老闸门放行,而误差恰恰是最大的那一档。
    expect(Number.isInteger(1)).toBe(true)          // 老判据说:可以用
    expect(webglCellFits(MESLO(12.5), 1)).toBe(false) // 新判据说:不行
  })

  it('字号变大也会失配:2× 屏 + 字号 14 ⇒ 16.8574,溢出 0.86', () => {
    expect(webglCellFits(MESLO(14), 2)).toBe(false)
  })

  it('分数 dpr(窗口缩放 / Windows 125%)照旧回落 —— 新判据不比老判据松', () => {
    expect(webglCellFits(MESLO(12.5), 1.25)).toBe(false)
    expect(webglCellFits(MESLO(12.5), 1.5)).toBe(false)
  })

  it('★乘出来正好是整数就允许,哪怕 dpr 是分数 —— 那种情况格子是精确的,老判据白白回落了', () => {
    expect(webglCellFits(8, 1.5)).toBe(true)   // 12
    expect(webglCellFits(7.5, 2)).toBe(true)   // 15
  })

  it('★量不出字宽(拿不到 canvas)一律不用 GPU —— 宁可慢,不可画错', () => {
    for (const bad of [null, undefined, 0, -3, NaN, Infinity]) {
      expect(webglCellFits(bad as number | null, 2), String(bad)).toBe(false)
    }
  })

  it('dpr 不可用时同样回落', () => {
    expect(webglCellFits(7.5, 0)).toBe(false)
    expect(webglCellFits(7.5, NaN)).toBe(false)
  })

  it('阈值两侧的行为:明显小于放行、明显大于回落', () => {
    // ★不去断言「正好等于上限」那一点 —— 二进制浮点里 (1+0.2)-1 = 0.19999999999999996,
    //   在门槛上写等号等于在测浮点噪声,不是在测行为。两侧留出余量才是真断言。
    expect(webglCellFits(1 + MAX_CELL_OVERHANG / 2, 1)).toBe(true)
    expect(webglCellFits(1 + MAX_CELL_OVERHANG * 2, 1)).toBe(false)
  })
})
