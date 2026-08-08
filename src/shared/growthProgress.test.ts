import { describe, it, expect } from 'vitest'
import { growthActionFor, resolveGrowthAction, pickGrowthSprite } from './growthProgress'
import type { GrowthManifest } from './growthPet'

const M: GrowthManifest = {
  id: 'growth-tree',
  name: '成长树',
  atlas: { cols: 8, cellW: 192, cellH: 208 },
  actions: {
    idle: { row: 0, durations: [280, 110, 110] },
    working: { row: 1, durations: [120, 120] },
  },
  stages: [
    { from: 0, name: '种子', sheet: 'seed.png' },
    { from: 80000, name: '树干', sheet: 'trunk.png' },
    { from: 180000, name: '结果', sheet: 'fruit.png' },
  ],
}

// ★ 上下限原本只在 computeDailyGoal 里生效,用户手填那条路(设置 → schema → 计数器)全程不 clamp。
// 抽出这个共用函数就是为了让两条路共享同一套边界。



describe('growthActionFor', () => {
  it('confirm 和 input 都映射到 alert', () => {
    expect(growthActionFor('confirm')).toBe('alert')
    expect(growthActionFor('input')).toBe('alert')
  })
  it('working 映射到 working,其余到 idle', () => {
    expect(growthActionFor('working')).toBe('working')
    expect(growthActionFor('idle')).toBe('idle')
    expect(growthActionFor('done')).toBe('idle')
  })
})

describe('resolveGrowthAction', () => {
  it('有就用', () => {
    expect(resolveGrowthAction('working', new Set(['idle', 'working'] as const))).toBe('working')
  })
  it('没有就回落到 idle', () => {
    expect(resolveGrowthAction('working', new Set(['idle'] as const))).toBe('idle')
    expect(resolveGrowthAction('alert', new Set(['idle'] as const))).toBe('idle')
  })
})

describe('pickGrowthSprite', () => {
  it('取最后一个 from <= todayTokens 的阶段', () => {
    expect(pickGrowthSprite(M, 0, 'idle').stageIndex).toBe(0)
    expect(pickGrowthSprite(M, 78000, 'idle').stageIndex).toBe(0)
    expect(pickGrowthSprite(M, 100000, 'idle').stageIndex).toBe(1)
    expect(pickGrowthSprite(M, 200000, 'idle').stageIndex).toBe(2)
  })

  it('todayTokens 正好等于某个 from 时进入该阶段(边界归后不归前)', () => {
    expect(pickGrowthSprite(M, 80000, 'idle').stageIndex).toBe(1)
    expect(pickGrowthSprite(M, 180000, 'idle').stageIndex).toBe(2)
  })

  it('subProgress 是本阶段内走完的比例', () => {
    // 阶段 0 跨度 0→0.4,进度 0.2 = 走了一半。
    expect(pickGrowthSprite(M, 40000, 'idle').subProgress).toBeCloseTo(0.5)
    // 阶段 1 跨度 0.4→0.9,进度 0.65 = 走了一半。
    expect(pickGrowthSprite(M, 130000, 'idle').subProgress).toBeCloseTo(0.5)
  })

  it('最后一个阶段的 subProgress 恒为 1(它没有下一档可比)', () => {
    expect(pickGrowthSprite(M, 180000, 'idle').subProgress).toBe(1)
    expect(pickGrowthSprite(M, 200000, 'idle').subProgress).toBe(1)
  })

  it('带出该动作的行号与逐帧时长', () => {
    const p = pickGrowthSprite(M, 100000, 'working')
    expect(p.action).toBe('working')
    expect(p.row).toBe(1)
    expect(p.durations).toEqual([120, 120])
    expect(p.sheet).toBe('trunk.png')
  })

  it('包里没有该动作时回落到 idle 的行与时长', () => {
    // M 没画 alert 行。
    const p = pickGrowthSprite(M, 100000, 'confirm')
    expect(p.action).toBe('idle')
    expect(p.row).toBe(0)
    expect(p.durations).toEqual([280, 110, 110])
  })

  it('todayTokens 超出 0~1 也不越界', () => {
    expect(pickGrowthSprite(M, -200000, 'idle').stageIndex).toBe(0)
    expect(pickGrowthSprite(M, 1000000, 'idle').stageIndex).toBe(2)
  })
})
