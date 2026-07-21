export type StageStatus = 'pending' | 'running' | 'awaiting-gate' | 'done' | 'stale'

export interface StagePlan {
  key: string
  name: string
  provider: string
  model: string
  scope: 'root' | 'per-project'
  gate: boolean
  prompt?: string
  // ②多镜头CR: the code-review (代码 CR) stage's fan-out config, threaded from the workspace stage
  // config (WsStage.review) via planFromStages. When present and in lens mode (mode:'parallel',
  // reviewers = ReviewLens[]), fanout.buildWorkOrders fans this stage into one reviewer per lens at
  // the workspace root instead of the plain root/per-project shapes — see reviewFanout.ts. Absent for
  // every non-review stage (and for a review stage left at 'off'/'single'), so those behave exactly
  // as before this existed.
  review?: import('@shared/types').ReviewConfig
}
export interface StageState { key: string; status: StageStatus; round: number }
// tempBranch: the local git branch (`forge/run-<runId>`, see tempBranch.ts) every participating
// project's worktree is checked out onto before lanes start — same name across all repos in the run,
// only each project's cwd differs. Optional so pre-existing RunPlan literals in tests keep compiling.
export interface RunPlan {
  runId: string
  stages: StagePlan[]
  tempBranch?: string
  // ③stage hooks: workflow-scope hooks woven into this run by `after` ('__start' / a stage key /
  // '__wf') — see hooks.ts (collectRunHooks/hooksAfter). Threaded from the workspace's plugins at
  // launch (planFromStages). Absent/empty for the raw run2:start channel and any run with no hooks,
  // so those behave exactly as before this existed.
  hooks?: import('../../shared/plugin').Plugin[]
}
export interface MachineState { plan: RunPlan; stages: StageState[]; currentIndex: number }

export function initMachine(plan: RunPlan): MachineState {
  return {
    plan,
    stages: plan.stages.map((s) => ({ key: s.key, status: 'pending' as StageStatus, round: 0 })),
    currentIndex: 0,
  }
}

export function stageIndex(s: MachineState, key: string): number {
  return s.stages.findIndex((x) => x.key === key)
}

export function currentStage(s: MachineState): StageState | null {
  return s.stages[s.currentIndex] ?? null
}

function clone(s: MachineState): MachineState {
  return { plan: s.plan, currentIndex: s.currentIndex, stages: s.stages.map((x) => ({ ...x })) }
}

export function markRunning(s: MachineState): MachineState {
  const n = clone(s)
  const cur = n.stages[n.currentIndex]
  if (cur && (cur.status === 'pending' || cur.status === 'stale')) cur.status = 'running'
  return n
}

export function advance(s: MachineState): MachineState {
  const n = clone(s)
  const cur = n.stages[n.currentIndex]
  if (cur) cur.status = 'done'
  let i = n.currentIndex + 1
  while (i < n.stages.length && n.stages[i].status === 'done') i++
  n.currentIndex = Math.min(i, n.stages.length - 1)
  return n
}

export function redo(s: MachineState): MachineState {
  const n = clone(s)
  const cur = n.stages[n.currentIndex]
  if (cur) { cur.round++; cur.status = 'running' }
  return n
}

export function jumpBack(s: MachineState, targetKey: string): MachineState {
  const idx = stageIndex(s, targetKey)
  if (idx < 0) return s
  const n = clone(s)
  for (let i = idx + 1; i < n.stages.length; i++) {
    if (n.stages[i].status === 'done') n.stages[i].status = 'stale'
  }
  const target = n.stages[idx]
  target.round++
  target.status = 'running'
  n.currentIndex = idx
  return n
}
