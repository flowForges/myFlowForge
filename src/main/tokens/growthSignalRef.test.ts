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

  // 回归:add/setGoalOverride 会同步走到 onChange → registry.broadcast → webContents.send。
  // 那条链路上任何一环抛异常都不能冒到 chatService.finishOk —— 否则消息已落盘、
  // clearLive/emit('done') 却不会执行,UI 永远停在「运行中」。
  it('onChange 抛异常时不向外抛', () => {
    setDailyTokenCounter(createDailyTokenCounter({
      baseline: { today: 0, recentDayTotals: [] }, day: '2026-08-07',
      onChange: () => { throw new Error('broadcast boom') },
    }))
    expect(() => addDailyTokens(1_000)).not.toThrow()
    expect(() => setGrowthGoalOverride(400_000)).not.toThrow()
    // 异常被吃掉,但计数本身仍然生效(抛在 notify 阶段,累加已经完成)
    expect(currentGrowthSignal()?.todayTokens).toBe(1_000)
  })

  it('转发 goal 覆盖', () => {
    setDailyTokenCounter(createDailyTokenCounter({
      baseline: { today: 100_000, recentDayTotals: [] }, day: '2026-08-07',
    }))
    setGrowthGoalOverride(400_000)
    expect(currentGrowthSignal()?.goal).toBe(400_000)
  })
})
