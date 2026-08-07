import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setDailyTokenCounter, addDailyTokens, currentGrowthSignal, setGrowthGoalOverride } from './growthSignalRef'
import { createDailyTokenCounter } from './dailyTokenCounter'

beforeEach(() => setDailyTokenCounter(null))

describe('growthSignalRef', () => {
  it('没装计数器时所有调用都是安全的空操作', () => {
    expect(currentGrowthSignal()).toBeNull()
    expect(() => addDailyTokens(100)).not.toThrow()
    expect(() => setGrowthGoalOverride(1000)).not.toThrow()
  })

  it('装上后转发累加', () => {
    const onChange = vi.fn()
    setDailyTokenCounter(createDailyTokenCounter({
      baseline: { today: 0, recentDayTotals: [200_000] }, day: '2026-08-07', onChange,
    }))
    addDailyTokens(20_000)
    expect(currentGrowthSignal()?.todayTokens).toBe(20_000)
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('转发 goal 覆盖', () => {
    setDailyTokenCounter(createDailyTokenCounter({
      baseline: { today: 100_000, recentDayTotals: [] }, day: '2026-08-07',
    }))
    setGrowthGoalOverride(400_000)
    expect(currentGrowthSignal()?.goal).toBe(400_000)
  })
})
