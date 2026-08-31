// src/renderer/views/chat/jumpRailLayout.test.ts
import { describe, it, expect } from 'vitest'
import { computeRailLayout, bucketGroups, railCapacity, MIN_DOTS, RAIL_MAX_OFFSET, DOT_H, DOT_GAP } from './jumpRailLayout'

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
    // 840 高的对话区:预算 = 840-210 = 630;(630+4)/10 = 63.4 → 63
    expect(railCapacity(840)).toBe(63)
    // 真 Chrome 实测过 63 个仍是自然的 6px,64 个就开始压扁
    expect(63 * 6 + 62 * 4).toBeLessThanOrEqual(840 - 210)
    expect(64 * 6 + 63 * 4).toBeGreaterThan(840 - 210)
  })

  it('★★算出来的容量真的塞得下 —— 这条钉的是 TS 和 chat.css 那句 max-height 没有漂移', () => {
    for (const h of [600, 840, 1040, 1600]) {
      const n = railCapacity(h)
      expect(n * DOT_H + (n - 1) * DOT_GAP, `容器 ${h}`).toBeLessThanOrEqual(h - RAIL_MAX_OFFSET)
    }
  })

  it('★窗口很矮时也要留住最少几个 —— 容量算成 1 等于没有导航', () => {
    expect(railCapacity(200)).toBe(MIN_DOTS)
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
