// src/renderer/views/chat/jumpRailLayout.test.ts
import { describe, it, expect } from 'vitest'
import { computeRailLayout } from './jumpRailLayout'

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
