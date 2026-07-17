export type StageStatus = 'pending' | 'running' | 'awaiting-gate' | 'done' | 'stale'

export interface StagePlan {
  key: string
  name: string
  provider: string
  model: string
  scope: 'root' | 'per-project'
  gate: boolean
}
export interface StageState { key: string; status: StageStatus; round: number }
export interface RunPlan { runId: string; stages: StagePlan[] }
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
