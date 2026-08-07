import { describe, it, expect, vi } from 'vitest'
import { createDailyTokenCounter, scanTokenBaseline, localDayKey, dayKeyMinus } from './dailyTokenCounter'
import { GROWTH_GOAL_DEFAULT, GROWTH_GOAL_MIN, GROWTH_GOAL_MAX } from '@shared/growthProgress'
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

  // ★ 设计文档 §2.3:中位数取的是「过去 7 天里有数据的那些天」。原实现没有窗口,收的是全量历史 ——
  // 一个用了半年的用户前三个月轻度、最近重度,中位数会被三个月前的数据钉死,天天秒满进度条。
  it('只收过去 7 天,更早的历史一律不进中位数', () => {
    const rows = [
      row('2026-08-06', 500_000, 0),    // 昨天,进
      row('2026-08-01', 400_000, 0),    // 6 天前,进
      row('2026-07-31', 300_000, 0),    // 正好 7 天前,进(窗口含下界)
      row('2026-07-30', 1, 0),          // 8 天前,出
      row('2026-05-01', 2, 0),          // 三个月前的轻度期,出
    ]
    const b = scanTokenBaseline('2026-08-07', rows)
    expect(b.recentDayTotals.sort((a, c) => a - c)).toEqual([300_000, 400_000, 500_000])
  })

  it('窗口下界跟着注入的 today 走(不依赖真实日期),跨月也对', () => {
    const rows = [row('2026-03-02', 10, 0), row('2026-02-23', 20, 0), row('2026-02-22', 30, 0)]
    // today=2026-03-01 → 窗口 [2026-02-22, 2026-02-28]:02-23 与 02-22 都在,03-02 是"未来"排除
    expect(scanTokenBaseline('2026-03-01', rows).recentDayTotals.sort((a, c) => a - c)).toEqual([20, 30])
    // today 往后挪一天 → 02-22 掉出窗口
    expect(scanTokenBaseline('2026-03-02', rows).recentDayTotals).toEqual([20])
  })

  it('系统时钟被改出来的"未来"记录不算进基线', () => {
    const rows = [row('2026-08-06', 100, 0), row('2026-09-30', 999_999, 0)]
    expect(scanTokenBaseline('2026-08-07', rows).recentDayTotals).toEqual([100])
  })
})

describe('dayKeyMinus', () => {
  it('同月内直接减', () => {
    expect(dayKeyMinus('2026-08-07', 7)).toBe('2026-07-31')
    expect(dayKeyMinus('2026-08-30', 1)).toBe('2026-08-29')
  })
  it('跨月/跨年/闰年都不出错(纯 UTC 算术,不受本地时区与夏令时影响)', () => {
    expect(dayKeyMinus('2026-03-01', 7)).toBe('2026-02-22')
    expect(dayKeyMinus('2026-01-03', 7)).toBe('2025-12-27')
    expect(dayKeyMinus('2024-03-01', 1)).toBe('2024-02-29')   // 闰年
    // 美国夏令时切换日(2026-03-08)前后:按本地时间做算术会差 1 小时,可能跨错日。
    expect(dayKeyMinus('2026-03-09', 1)).toBe('2026-03-08')
    expect(dayKeyMinus('2026-03-08', 1)).toBe('2026-03-07')
  })
  it('非法日期串退化成原值(等价 cutoff=today,把窗口塌缩成空,历史全被排除),不抛不产出 NaN 串', () => {
    expect(dayKeyMinus('not-a-day', 7)).toBe('not-a-day')
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

  // ★ 上下限原本只在 computeDailyGoal 里生效,override 一路裸奔到这里。settings.json 是纯文本、
  // 用户改得了,旧版本也可能写下越界值 —— 这一层是所有读取路径的汇合点,必须自己 clamp。
  it('override 低于下限被抬到 MIN(填 1 不该让进度条恒满)', () => {
    const c = createDailyTokenCounter({
      baseline: { today: 100_000, recentDayTotals: [] }, day: '2026-08-07', goalOverride: 1,
    })
    expect(c.signal().goal).toBe(GROWTH_GOAL_MIN)
    // 没 clamp 的话 progress 恒为 1,宠物永远停在最后一档
    expect(c.signal().progress).toBe(1)   // 100k / 50k > 1 → 封顶 1,但 goal 是 50000 不是 1
    const c2 = createDailyTokenCounter({
      baseline: { today: 10_000, recentDayTotals: [] }, day: '2026-08-07', goalOverride: 1,
    })
    expect(c2.signal().progress).toBeCloseTo(0.2)   // 10k / 50k;没 clamp 的话是 1
  })

  it('override 高于上限被压到 MAX', () => {
    const c = createDailyTokenCounter({
      baseline: { today: 0, recentDayTotals: [] }, day: '2026-08-07', goalOverride: 1e12,
    })
    expect(c.signal().goal).toBe(GROWTH_GOAL_MAX)
  })

  it('setGoalOverride 同样 clamp(设置面板改一次也走这条路)', () => {
    const c = createDailyTokenCounter({ baseline: { today: 0, recentDayTotals: [] }, day: '2026-08-07' })
    c.setGoalOverride(1)
    expect(c.signal().goal).toBe(GROWTH_GOAL_MIN)
    c.setGoalOverride(99_000_000)
    expect(c.signal().goal).toBe(GROWTH_GOAL_MAX)
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
