// src/renderer/views/chat/jumpRailLayout.test.ts
import { describe, it, expect } from 'vitest'
import { computeRailLayout, bucketGroups, railCapacity, MIN_DOTS, RAIL_PAD, DOT_H, DOT_GAP } from './jumpRailLayout'

describe('computeRailLayout', () => {
  it('empty offsets → no active, no tops', () => {
    expect(computeRailLayout({ offsets: [], scrollTop: 0, maxScroll: 100, railH: 200 }))
      .toEqual({ tops: [], activeIndex: -1 })
  })

  it('maps offsets proportionally onto the rail span (top = 12 + ratio*(railH-24))', () => {
    // offsets 0 and (maxScroll+18) → targets clamp to 0 and maxScroll → ratios 0 and 1
    const r = computeRailLayout({ offsets: [18, 1018], scrollTop: 0, maxScroll: 1000, railH: 224 })
    expect(r.tops[0]).toBeCloseTo(12, 5)          // 12 + 0*(200)
    expect(r.tops[1]).toBeCloseTo(212, 5)         // 12 + 1*(224-24)
  })

  it('active = dot whose target is nearest current scrollTop', () => {
    const r = computeRailLayout({ offsets: [18, 518, 1018], scrollTop: 500, maxScroll: 1000, railH: 224 })
    // targets: 0, 500, 1000 → nearest to 500 is index 1
    expect(r.activeIndex).toBe(1)
  })

  it('guards maxScroll<=0 (content fits one screen) without divide-by-zero', () => {
    const r = computeRailLayout({ offsets: [0, 0], scrollTop: 0, maxScroll: 0, railH: 40 })
    expect(r.tops.every(t => Number.isFinite(t))).toBe(true)
    expect(r.activeIndex).toBe(0)
  })
})

describe('railCapacity', () => {
  it('★按「不被压扁」算容量,不是按「不溢出」算', () => {
    // 840 高的**滚动区**:预算 = 840 - 24*2 = 792;(792+4)/10 = 79.6 → 79
    expect(railCapacity(840)).toBe(79)
    // 79 个仍是自然的 6px,80 个就开始压扁
    expect(79 * DOT_H + 78 * DOT_GAP).toBeLessThanOrEqual(840 - RAIL_PAD * 2)
    expect(80 * DOT_H + 79 * DOT_GAP).toBeGreaterThan(840 - RAIL_PAD * 2)
  })

  it('★★算出来的容量真的塞得下', () => {
    for (const h of [600, 840, 1040, 1600]) {
      const n = railCapacity(h)
      expect(n * DOT_H + (n - 1) * DOT_GAP, `滚动区 ${h}`).toBeLessThanOrEqual(h - RAIL_PAD * 2)
    }
  })

  it('★★★轨道的底边永远够不到输入框 —— 不管输入框有多高', () => {
    /**
     * 这是 2026-09-03 修的那个 bug 的形状,而且它是**几何**的,不是「数调小一点」。
     *
     * 轨道原来绝对定位在**整列**里、`top:50%` 居中,高度按 `整列 - 210` 算。列 = 滚动区 + 输入框,
     * 于是轨道底边落在 `列/2 + 轨道/2`,而输入框从 `滚动区` 那个位置开始。展开算:
     *   压到输入框 ⟺ 列/2 + (列-210)/2 > 滚动区 ⟺ **输入框 > 105**
     * 而真实的输入框带上附件条/模式条是 160~180,整窗缩放调大字号还要再涨。
     * 所以那个常量不是「调得不够保守」,是**它压根管不了这件事** —— 用户报的
     * 「锚点列表底部都已经到输入框这块了」就是它(那台电脑其实装着这个修复)。
     *
     * ★现在轨道按**滚动区那个盒子**摆:中心 = 滚动区中心,高度 = 滚动区 - 24*2。
     *  底边恒等于 `滚动区 - 24`,输入框天然在它外面 —— 多高都够不着。
     */
    const railH = (n: number) => n * DOT_H + (n - 1) * DOT_GAP
    /** 新做法:轨道中心 = 滚动区中心,底边在整列坐标里的位置。 */
    const newBottom = (scroller: number) => scroller / 2 + railH(railCapacity(scroller)) / 2
    /** 旧做法:轨道中心 = 整列中心,高度按 `整列 - 210` 的容量算。 */
    const oldBottom = (scroller: number, composer: number) => {
      const col = scroller + composer
      const n = Math.max(MIN_DOTS, Math.floor((col - 210 + DOT_GAP) / (DOT_H + DOT_GAP)))
      return col / 2 + railH(n) / 2
    }
    for (const scroller of [500, 700, 900, 1200]) {
      // 新做法:输入框多高都碰不到(底边只跟滚动区有关)
      expect(newBottom(scroller), `滚动区 ${scroller}`).toBeLessThanOrEqual(scroller)
      // 旧做法:输入框一超过 105 就压进去
      expect(oldBottom(scroller, 180), `滚动区 ${scroller} · 输入框 180`).toBeGreaterThan(scroller)
      expect(oldBottom(scroller, 160), `滚动区 ${scroller} · 输入框 160`).toBeGreaterThan(scroller)
    }
  })

  it('★窗口很矮时也要留住最少几个 —— 容量算成 1 等于没有导航', () => {
    // 预算 = h - 48;要算出 <6 个得 h < 104(旧公式那条线在 h < 266,因为它减的是 210)
    expect(railCapacity(100)).toBe(MIN_DOTS)
    expect(railCapacity(60)).toBe(MIN_DOTS)
    expect(railCapacity(0)).toBe(MIN_DOTS)
    expect(railCapacity(-5)).toBe(MIN_DOTS)
    expect(railCapacity(Number.NaN)).toBe(MIN_DOTS)
  })
})

describe('bucketGroups', () => {
  it('空的就是空的', () => {
    expect(bucketGroups(0, 10)).toEqual([])
    expect(bucketGroups(-3, 10)).toEqual([])
  })

  it('★没超上限时严格一条一个 —— 日常对话观感必须一个像素都不变', () => {
    expect(bucketGroups(3, 10)).toEqual([{ start: 0, size: 1 }, { start: 1, size: 1 }, { start: 2, size: 1 }])
    // 正好等于上限也不合并
    expect(bucketGroups(10, 10)).toHaveLength(10)
    expect(bucketGroups(10, 10).every(g => g.size === 1)).toBe(true)
  })

  it('★超了之后组数恰好等于上限', () => {
    expect(bucketGroups(300, 80)).toHaveLength(80)
    expect(bucketGroups(11, 10)).toHaveLength(10)
  })

  it('★★每一条都属于且仅属于一组,顺序不变、不重不漏', () => {
    for (const [count, cap] of [[300, 80], [11, 10], [1000, 7], [97, 13]] as const) {
      const gs = bucketGroups(count, cap)
      expect(gs[0]!.start, `${count}/${cap}`).toBe(0)
      let expected = 0
      for (const g of gs) {
        expect(g.start, `${count}/${cap}`).toBe(expected)   // 首尾相接,不留空洞
        expect(g.size).toBeGreaterThan(0)                    // 没有空组
        expected += g.size
      }
      expect(expected, `${count}/${cap} 覆盖总数`).toBe(count)
    }
  })

  it('★组间大小最多差 1 —— 不许出现一个组吞掉一大半', () => {
    for (const [count, cap] of [[300, 80], [11, 10], [1000, 7], [97, 13]] as const) {
      const sizes = bucketGroups(count, cap).map(g => g.size)
      expect(Math.max(...sizes) - Math.min(...sizes), `${count}/${cap}`).toBeLessThanOrEqual(1)
    }
  })

  it('★★余数分给旧的那一头 —— 最近的几组要最小、定位最准', () => {
    // 11 条 / 10 个位置:第一组担 2 条,其余各 1 条
    expect(bucketGroups(11, 10).map(g => g.size)).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    // 10 条 / 4 个位置:[3,3,2,2] —— 越靠后(越新)越小
    expect(bucketGroups(10, 4).map(g => g.size)).toEqual([3, 3, 2, 2])
    const sizes = bucketGroups(10, 4).map(g => g.size)
    expect(sizes[0]).toBeGreaterThanOrEqual(sizes[sizes.length - 1]!)
  })

  it('容量给了 0 或负数时不炸,退化成一个组', () => {
    expect(bucketGroups(5, 0)).toEqual([{ start: 0, size: 5 }])
    expect(bucketGroups(5, -1)).toEqual([{ start: 0, size: 5 }])
  })
})
