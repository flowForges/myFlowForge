import { describe, it, expect, vi } from 'vitest'
import { createDailyTokenCounter, scanTokenBaseline, localDayKey } from './dailyTokenCounter'
import { GROWTH_GOAL_DEFAULT } from '@shared/growthProgress'
import type { TokenUsageRow } from '../ipc/tokenUsageHandlers'

function row(day: string, input: number, output: number): TokenUsageRow {
  return { workspace: 'w', workspacePath: '/w', provider: 'claude', day, input, output, turns: 1, estimated: false }
}

describe('localDayKey', () => {
  it('按本地时区给 YYYY-MM-DD', () => {
    expect(localDayKey(new Date(2026, 7, 7, 23, 59))).toBe('2026-08-07')
    expect(localDayKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })
})

describe('scanTokenBaseline', () => {
  it('拆出今天的总量和过去各天的总量', () => {
    const rows = [
      row('2026-08-07', 100, 50),   // 今天
      row('2026-08-07', 10, 5),     // 今天(另一个 provider)
      row('2026-08-06', 700, 300),
      row('2026-08-05', 400, 100),
    ]
    const b = scanTokenBaseline('2026-08-07', rows)
    expect(b.today).toBe(165)
    expect(b.recentDayTotals.sort((a, c) => a - c)).toEqual([500, 1000])
  })

  it('今天没有记录时基线为 0', () => {
    expect(scanTokenBaseline('2026-08-07', [row('2026-08-01', 10, 10)]).today).toBe(0)
  })
})

describe('createDailyTokenCounter', () => {
  it('用基线开局,goal 由历史中位数推出', () => {
    const c = createDailyTokenCounter({
      baseline: { today: 50_000, recentDayTotals: [100_000, 200_000, 300_000] },
      day: '2026-08-07',
    })
    const s = c.signal()
    expect(s.todayTokens).toBe(50_000)
    expect(s.goal).toBe(200_000)
    expect(s.progress).toBeCloseTo(0.25)
  })

  it('无历史时用默认 goal', () => {
    const c = createDailyTokenCounter({ baseline: { today: 0, recentDayTotals: [] }, day: '2026-08-07' })
    expect(c.signal().goal).toBe(GROWTH_GOAL_DEFAULT)
  })

  it('累加并通知', () => {
    const onChange = vi.fn()
    const c = createDailyTokenCounter({
      baseline: { today: 0, recentDayTotals: [200_000] }, day: '2026-08-07', onChange,
    })
    c.add(20_000)
    expect(c.signal().todayTokens).toBe(20_000)
    expect(c.signal().progress).toBeCloseTo(0.1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ todayTokens: 20_000 }))
  })

  it('累加 0 或负数不通知(避免无意义广播)', () => {
    const onChange = vi.fn()
    const c = createDailyTokenCounter({
      baseline: { today: 0, recentDayTotals: [] }, day: '2026-08-07', onChange,
    })
    c.add(0)
    c.add(-5)
    expect(onChange).not.toHaveBeenCalled()
    expect(c.signal().todayTokens).toBe(0)
  })

  it('跨日:下一次累加时先归零再计入新的一天', () => {
    let today = new Date(2026, 7, 7, 23, 59)
    const c = createDailyTokenCounter({
      baseline: { today: 500_000, recentDayTotals: [200_000] },
      day: '2026-08-07',
      now: () => today,
    })
    expect(c.signal().todayTokens).toBe(500_000)

    today = new Date(2026, 7, 8, 0, 1)
    c.add(3_000)
    expect(c.signal().day).toBe('2026-08-08')
    expect(c.signal().todayTokens).toBe(3_000)   // 不是 503,000
  })

  it('goalOverride 覆盖历史推算值', () => {
    const c = createDailyTokenCounter({
      baseline: { today: 100_000, recentDayTotals: [1_000_000] },
      day: '2026-08-07',
      goalOverride: 400_000,
    })
    expect(c.signal().goal).toBe(400_000)
    expect(c.signal().progress).toBeCloseTo(0.25)
  })

  it('setGoalOverride 立即改写 goal 并通知', () => {
    const onChange = vi.fn()
    const c = createDailyTokenCounter({
      baseline: { today: 100_000, recentDayTotals: [] }, day: '2026-08-07', onChange,
    })
    c.setGoalOverride(500_000)
    expect(c.signal().goal).toBe(500_000)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ goal: 500_000 }))
    c.setGoalOverride(undefined)   // 回到自动
    expect(c.signal().goal).toBe(GROWTH_GOAL_DEFAULT)
  })
})
