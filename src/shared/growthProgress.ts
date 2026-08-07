// 成长宠物的运行时数学:今日 token → 0~1 进度 → 选中哪个阶段/哪一行动作。
// 纯:无 DOM、无 IO。main 用它算进度并广播,renderer 用它选图。
import type { GrowthAction, GrowthManifest } from './growthPet'
import type { PetState } from './types'

// 每日目标的上下限与首次默认。作者在包里排的是「节奏」(0~1 的相对位置),使用者一天用多少 token
// 由这个分母吸收 —— 重度 claude 用户(日耗数百万)和 codex 用户(估算值偏小)才能走完同一条曲线。
export const GROWTH_GOAL_MIN = 50_000
export const GROWTH_GOAL_MAX = 5_000_000
export const GROWTH_GOAL_DEFAULT = 200_000

/**
 * 把任意 goal 收进 [MIN, MAX]。自动推算与用户手填必须共用这一条 —— 上下限原来只在
 * computeDailyGoal 里生效,手填那条路(设置 → schema → 计数器)全程没人 clamp,结果是
 * 输入 1 就让 progress 恒等于 1、宠物永远停在最后一档,而且没有任何提示解释为什么。
 * 非数字/非正数 → undefined,交给调用方决定回落到自动还是默认。
 */
export function clampDailyGoal(goal: number | undefined): number | undefined {
  if (goal == null || !Number.isFinite(goal) || goal <= 0) return undefined
  return Math.round(Math.min(GROWTH_GOAL_MAX, Math.max(GROWTH_GOAL_MIN, goal)))
}

/**
 * 由「过去若干天各自的 token 总量」推每日目标。
 * 用中位数而非平均:某一天通宵会把平均永久拉高,从此再也长不到结果。
 * 只算有用量的天 —— 没干活的那天不该把基线压低。
 */
export function computeDailyGoal(dayTotals: number[]): number {
  const used = dayTotals.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (!used.length) return GROWTH_GOAL_DEFAULT
  const mid = used.length >> 1
  const median = used.length % 2 ? used[mid] : (used[mid - 1] + used[mid]) / 2
  return clampDailyGoal(median) ?? GROWTH_GOAL_DEFAULT
}

/** 今日累计 → 0~1。只增不减、封顶 1(达标后停在最后一档,不循环不溢出)。 */
export function growthProgress(todayTokens: number, goal: number): number {
  if (!Number.isFinite(goal) || goal <= 0) return 0
  if (!Number.isFinite(todayTokens) || todayTokens <= 0) return 0
  return Math.min(1, todayTokens / goal)
}

/** 宠物状态 → 成长包的动作。confirm/input 共用 alert 一行;done 不单开行(靠宿主撒光点动效)。 */
export function growthActionFor(state: PetState): GrowthAction {
  if (state === 'working') return 'working'
  if (state === 'confirm' || state === 'input') return 'alert'
  return 'idle'
}

/** 包里没画这一行就退回 idle —— idle 由 parseGrowthManifest 保证一定存在。 */
export function resolveGrowthAction(desired: GrowthAction, available: ReadonlySet<GrowthAction>): GrowthAction {
  return available.has(desired) ? desired : 'idle'
}

export interface GrowthPick {
  stageIndex: number
  sheet: string
  action: GrowthAction
  row: number
  durations: number[]
  /** 本阶段内已走完的比例(0~1)。最后一个阶段恒为 1 —— 它没有下一档可比。 */
  subProgress: number
}

export function pickGrowthSprite(m: GrowthManifest, progress: number, state: PetState): GrowthPick {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0

  // 最后一个 at <= p 的阶段。边界值归后不归前:进度正好等于某个 at 就算进入了那一档。
  let stageIndex = 0
  for (let i = 0; i < m.stages.length; i++) {
    if (m.stages[i].at <= p) stageIndex = i
    else break
  }
  const stage = m.stages[stageIndex]
  const next = m.stages[stageIndex + 1]
  const span = next ? next.at - stage.at : 0
  const subProgress = span > 0 ? Math.min(1, Math.max(0, (p - stage.at) / span)) : 1

  const available = new Set(Object.keys(m.actions) as GrowthAction[])
  const action = resolveGrowthAction(growthActionFor(state), available)
  // parseGrowthManifest 保证 idle 存在,故这里的兜底只是让类型收窄。
  const cfg = m.actions[action] ?? m.actions.idle ?? { row: 0, durations: [500] }

  return { stageIndex, sheet: stage.sheet, action, row: cfg.row, durations: cfg.durations, subProgress }
}
