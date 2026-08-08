// 「今日累计 token」的实时计数器 —— 成长宠物的唯一数据源。
//
// 为什么不直接用 aggregateTokenUsage():那个函数遍历所有工作区的 .forge/sessions/*.jsonl 读全部
// 消息,是全量重扫,只适合设置面板点一次。宠物需要每轮对话都更新,不能每次都扫盘。
//
// 所以:启动时扫一次拿基线,之后每轮对话结束在 chatService.finishOk 里累加。内存态,不落盘 ——
// 少一个要维护一致性的文件;app 重启由启动扫盘重建,成本只有一次。
import { aggregateTokenUsage, type TokenUsageRow } from '../ipc/tokenUsageHandlers'

/** 本地时区的 YYYY-MM-DD。与 tokenUsageHandlers 里的 dayOf 同一套口径(那边入参是 ISO 字符串)。 */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 只广播「今天累计了多少 token」。以前还带 goal/progress —— 那是阶段门槛用百分比时代的产物,
// 需要一个全局分母。现在每个成长包用绝对区间自带节奏(GrowthStage.from),分母和进度都不存在了。
export interface GrowthSignal {
  day: string
  todayTokens: number
}

export interface TokenBaseline {
  today: number
  /** 过去 GROWTH_BASELINE_DAYS 天(不含今天)里,每一天各自的 token 总量。目前只用于诊断/展示。 */
  recentDayTotals: number[]
}

/**
 * 中位数窗口的天数。设计文档 §2.3 写的是「过去 7 天里有数据的那些天的中位数」。
 * 为什么必须有窗口:aggregateTokenUsage 给的是全部历史。一个用了半年的用户,前三个月轻度、
 * 最近重度,不设窗口的话中位数会被三个月前的数据钉住,每天开工没多久进度条就满了,宠物再也不长。
 */
export const GROWTH_BASELINE_DAYS = 7

/**
 * 'YYYY-MM-DD' 往前推 n 天,仍返回 'YYYY-MM-DD'。
 * 用 Date.UTC 纯算术:入参出参都是「日历日」字符串、没有时刻概念,走 UTC 只是借它当算盘,
 * 顺带避开本地时区在夏令时切换那天 ±1 小时导致的跨日误差。不引任何日期库。
 */
export function dayKeyMinus(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d - n)
  // day 不是合法日期串:原样返回,即 cutoff === today。scanTokenBaseline 里 `r.day < cutoff` 会把
  // 所有早于 today 的行都当成窗口外——不是「不设下界」,恰恰相反,是把窗口塌缩成空,历史全被排除
  // (recentDayTotals 为空,goal 落回默认值)。生产里 today 恒来自 localDayKey,从不会走到这条分支;
  // 这里选择安全降级而不是抛错,只是把这句注释写成了跟实际行为相反的话,顺手改准。
  if (!Number.isFinite(t)) return day
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/**
 * 把一次全量聚合拆成「今天的量」和「过去 7 天每天的量」。rows 可注入,便于单测。
 * `today` 同时驱动窗口下界,所以测试不依赖真实日期。
 */
export function scanTokenBaseline(today: string, rows: TokenUsageRow[] = aggregateTokenUsage()): TokenBaseline {
  let todayTotal = 0
  const byDay = new Map<string, number>()
  // 窗口 = [cutoff, today):含 cutoff、不含今天,正好 GROWTH_BASELINE_DAYS 天。
  const cutoff = dayKeyMinus(today, GROWTH_BASELINE_DAYS)
  for (const r of rows) {
    const total = (r.input || 0) + (r.output || 0)
    if (r.day === today) { todayTotal += total; continue }
    // YYYY-MM-DD 是定宽零填充的,字符串字典序 === 日期先后序,直接比就行。
    // r.day > today 的("未来"的行,只可能来自改过的系统时钟)也排除:它不属于"过去 7 天"。
    if (r.day < cutoff || r.day > today) continue
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + total)
  }
  return { today: todayTotal, recentDayTotals: [...byDay.values()] }
}

export function createDailyTokenCounter(opts: {
  baseline: TokenBaseline
  day: string
  now?: () => Date
  onChange?: (s: GrowthSignal) => void
}) {
  const now = opts.now ?? (() => new Date())
  let day = opts.day
  let todayTokens = opts.baseline.today

  const signal = (): GrowthSignal => ({ day, todayTokens })
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
  }
}
