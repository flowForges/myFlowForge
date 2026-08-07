import { describe, it, expect } from 'vitest'
import {
  clampDailyGoal, computeDailyGoal, growthProgress, growthActionFor, resolveGrowthAction, pickGrowthSprite,
  GROWTH_GOAL_DEFAULT, GROWTH_GOAL_MIN, GROWTH_GOAL_MAX,
} from './growthProgress'
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
    { at: 0, name: '种子', sheet: 'seed.png' },
    { at: 0.4, name: '树干', sheet: 'trunk.png' },
    { at: 0.9, name: '结果', sheet: 'fruit.png' },
  ],
}

// ★ 上下限原本只在 computeDailyGoal 里生效,用户手填那条路(设置 → schema → 计数器)全程不 clamp。
// 抽出这个共用函数就是为了让两条路共享同一套边界。
describe('clampDailyGoal', () => {
  it('低于下限抬到 MIN —— 填 1 会让 progress 恒为 1,宠物永远停在最后一档', () => {
    expect(clampDailyGoal(1)).toBe(GROWTH_GOAL_MIN)
    expect(clampDailyGoal(GROWTH_GOAL_MIN - 1)).toBe(GROWTH_GOAL_MIN)
  })
  it('高于上限压到 MAX —— 填 1e12 会让进度条永远不动', () => {
    expect(clampDailyGoal(1e12)).toBe(GROWTH_GOAL_MAX)
    expect(clampDailyGoal(GROWTH_GOAL_MAX + 1)).toBe(GROWTH_GOAL_MAX)
  })
  it('范围内原样返回(边界含两端)', () => {
    expect(clampDailyGoal(GROWTH_GOAL_MIN)).toBe(GROWTH_GOAL_MIN)
    expect(clampDailyGoal(GROWTH_GOAL_MAX)).toBe(GROWTH_GOAL_MAX)
    expect(clampDailyGoal(200_000)).toBe(200_000)
  })
  it('空/非数/非正 → undefined(交给调用方回落到自动)', () => {
    expect(clampDailyGoal(undefined)).toBeUndefined()
    expect(clampDailyGoal(0)).toBeUndefined()
    expect(clampDailyGoal(-5)).toBeUndefined()
    expect(clampDailyGoal(NaN)).toBeUndefined()
    // Infinity 也走 undefined 而不是 MAX:它只可能来自坏数据,回落到自动比强行给个上限更诚实。
    expect(clampDailyGoal(Infinity)).toBeUndefined()
  })
})

describe('computeDailyGoal', () => {
  it('无历史时给保守默认', () => {
    expect(computeDailyGoal([])).toBe(GROWTH_GOAL_DEFAULT)
  })
  it('取中位数,不取平均 —— 一次通宵不该把基线永久拉高', () => {
    // 平均 = 1,325,000;中位数(中间两个 100,000 与 120,000 的均值) = 110,000。
    expect(computeDailyGoal([80_000, 100_000, 120_000, 5_000_000])).toBe(110_000)
  })
  it('偶数个取中间两个的均值', () => {
    expect(computeDailyGoal([100_000, 200_000])).toBe(150_000)
  })
  it('忽略 0 和负数(没干活的那天不该把基线压低)', () => {
    expect(computeDailyGoal([0, 0, 300_000])).toBe(300_000)
  })
  it('clamp 到上下限', () => {
    expect(computeDailyGoal([1_000])).toBe(GROWTH_GOAL_MIN)
    expect(computeDailyGoal([99_000_000])).toBe(GROWTH_GOAL_MAX)
  })
})

describe('growthProgress', () => {
  it('线性映射并封顶到 1', () => {
    expect(growthProgress(0, 200_000)).toBe(0)
    expect(growthProgress(100_000, 200_000)).toBeCloseTo(0.5)
    expect(growthProgress(999_000_000, 200_000)).toBe(1)
  })
  it('goal 非法时不产出 NaN/Infinity', () => {
    expect(growthProgress(100, 0)).toBe(0)
    expect(growthProgress(100, -5)).toBe(0)
  })
  it('负的今日用量按 0 处理', () => {
    expect(growthProgress(-100, 200_000)).toBe(0)
  })
})

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
  it('取最后一个 at <= progress 的阶段', () => {
    expect(pickGrowthSprite(M, 0, 'idle').stageIndex).toBe(0)
    expect(pickGrowthSprite(M, 0.39, 'idle').stageIndex).toBe(0)
    expect(pickGrowthSprite(M, 0.5, 'idle').stageIndex).toBe(1)
    expect(pickGrowthSprite(M, 1, 'idle').stageIndex).toBe(2)
  })

  it('progress 正好等于某个 at 时进入该阶段(边界归后不归前)', () => {
    expect(pickGrowthSprite(M, 0.4, 'idle').stageIndex).toBe(1)
    expect(pickGrowthSprite(M, 0.9, 'idle').stageIndex).toBe(2)
  })

  it('subProgress 是本阶段内走完的比例', () => {
    // 阶段 0 跨度 0→0.4,进度 0.2 = 走了一半。
    expect(pickGrowthSprite(M, 0.2, 'idle').subProgress).toBeCloseTo(0.5)
    // 阶段 1 跨度 0.4→0.9,进度 0.65 = 走了一半。
    expect(pickGrowthSprite(M, 0.65, 'idle').subProgress).toBeCloseTo(0.5)
  })

  it('最后一个阶段的 subProgress 恒为 1(它没有下一档可比)', () => {
    expect(pickGrowthSprite(M, 0.9, 'idle').subProgress).toBe(1)
    expect(pickGrowthSprite(M, 1, 'idle').subProgress).toBe(1)
  })

  it('带出该动作的行号与逐帧时长', () => {
    const p = pickGrowthSprite(M, 0.5, 'working')
    expect(p.action).toBe('working')
    expect(p.row).toBe(1)
    expect(p.durations).toEqual([120, 120])
    expect(p.sheet).toBe('trunk.png')
  })

  it('包里没有该动作时回落到 idle 的行与时长', () => {
    // M 没画 alert 行。
    const p = pickGrowthSprite(M, 0.5, 'confirm')
    expect(p.action).toBe('idle')
    expect(p.row).toBe(0)
    expect(p.durations).toEqual([280, 110, 110])
  })

  it('progress 超出 0~1 也不越界', () => {
    expect(pickGrowthSprite(M, -1, 'idle').stageIndex).toBe(0)
    expect(pickGrowthSprite(M, 5, 'idle').stageIndex).toBe(2)
  })
})
