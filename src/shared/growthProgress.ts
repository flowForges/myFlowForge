// 成长宠物的运行时数学:今日 token → 0~1 进度 → 选中哪个阶段/哪一行动作。
// 纯:无 DOM、无 IO。main 用它算进度并广播,renderer 用它选图。
import type { GrowthAction, GrowthManifest } from './growthPet'
import type { PetState } from './types'

// ★ 这里原先有一整套「每日 token 目标」:上下限、手填夹取、按历史中位数自动推算,外加 growthProgress()
// 把今日用量除以目标算成 0~1。整套东西存在的唯一理由是阶段门槛用的是百分比 —— 需要一个分母。
// 阶段改成绝对 token 区间(见 GrowthStage.from)之后,分母没有了:每个成长包自带节奏,pickGrowthSprite
// 直接吃今日 token。那个设置项也一并从「宠物」设置里去掉了 —— 它既没用了,摆在那儿还容易被误改。
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

/**
 * 今日 token → 该显示哪一阶段。
 *
 * 第二个参数是**今日 token 绝对值**,不再是 0~1 的进度 —— 阶段门槛现在由每个包自带(GrowthStage.from),
 * 不存在全局分母,所以也没有「进度」这个中间量了。
 */
export function pickGrowthSprite(m: GrowthManifest, todayTokens: number, state: PetState): GrowthPick {
  const p = Number.isFinite(todayTokens) && todayTokens > 0 ? todayTokens : 0

  // 最后一个 from <= p 的阶段。边界值归后不归前:正好等于某个 from 就算进入了那一档。
  let stageIndex = 0
  for (let i = 0; i < m.stages.length; i++) {
    if (m.stages[i].from <= p) stageIndex = i
    else break
  }
  const stage = m.stages[stageIndex]
  const next = m.stages[stageIndex + 1]
  const span = next ? next.from - stage.from : 0
  const subProgress = span > 0 ? Math.min(1, Math.max(0, (p - stage.from) / span)) : 1

  const available = new Set(Object.keys(m.actions) as GrowthAction[])
  const action = resolveGrowthAction(growthActionFor(state), available)
  // parseGrowthManifest 保证 idle 存在,故这里的兜底只是让类型收窄。
  const cfg = m.actions[action] ?? m.actions.idle ?? { row: 0, durations: [500] }

  return { stageIndex, sheet: stage.sheet, action, row: cfg.row, durations: cfg.durations, subProgress }
}
