// 「今日累计 token」的实时计数器 —— 成长宠物的唯一数据源。
//
// 为什么不直接用 aggregateTokenUsage():那个函数遍历所有工作区的 .forge/sessions/*.jsonl 读全部
// 消息,是全量重扫,只适合设置面板点一次。宠物需要每轮对话都更新,不能每次都扫盘。
//
// 所以:启动时扫一次拿基线,之后每轮对话结束在 chatService.finishOk 里累加。内存态,不落盘 ——
// 少一个要维护一致性的文件;app 重启由启动扫盘重建,成本只有一次。
import { aggregateTokenUsage, type TokenUsageRow } from '../ipc/tokenUsageHandlers'
import { computeDailyGoal, growthProgress } from '@shared/growthProgress'

/** 本地时区的 YYYY-MM-DD。与 tokenUsageHandlers 里的 dayOf 同一套口径(那边入参是 ISO 字符串)。 */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface GrowthSignal {
  day: string
  todayTokens: number
  goal: number
  progress: number
}

export interface TokenBaseline {
  today: number
  /** 除今天以外、每一天各自的 token 总量。用来推 goal 的中位数。 */
  recentDayTotals: number[]
}

/** 把一次全量聚合拆成「今天的量」和「过去每天的量」。rows 可注入,便于单测。 */
export function scanTokenBaseline(today: string, rows: TokenUsageRow[] = aggregateTokenUsage()): TokenBaseline {
  let todayTotal = 0
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const total = (r.input || 0) + (r.output || 0)
    if (r.day === today) { todayTotal += total; continue }
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + total)
  }
  return { today: todayTotal, recentDayTotals: [...byDay.values()] }
}

export function createDailyTokenCounter(opts: {
  baseline: TokenBaseline
  day: string
  /** 用户在设置里手填的每日目标;undefined = 自动按历史中位数。 */
  goalOverride?: number
  now?: () => Date
  onChange?: (s: GrowthSignal) => void
}) {
  const now = opts.now ?? (() => new Date())
  const autoGoal = computeDailyGoal(opts.baseline.recentDayTotals)
  let override = opts.goalOverride
  let day = opts.day
  let todayTokens = opts.baseline.today

  const goal = (): number => (override && override > 0 ? override : autoGoal)
  const signal = (): GrowthSignal => ({
    day, todayTokens, goal: goal(), progress: growthProgress(todayTokens, goal()),
  })
  const notify = () => opts.onChange?.(signal())

  return {
    signal,
    add(tokens: number): void {
      if (!Number.isFinite(tokens) || tokens <= 0) return
      // 跨日在这里发生 —— 不设午夜定时器。代价:凌晨不说话时画面还停在昨天的树,
      // 一说话立刻变回种子。换来的是省掉一个常驻定时器和一堆时区边界 bug。
      const key = localDayKey(now())
      if (key !== day) { day = key; todayTokens = 0 }
      todayTokens += tokens
      notify()
    },
    setGoalOverride(g: number | undefined): void {
      override = g && g > 0 ? g : undefined
      notify()
    },
  }
}
