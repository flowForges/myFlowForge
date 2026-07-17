import { stageScope, type StageSpec } from '../orchestrator/orchestrator'
import type { RunPlan, StagePlan } from './machine'

export function planFromStages(runId: string, stages: StageSpec[]): RunPlan {
  const mapped: StagePlan[] = stages.map((s) => ({
    key: s.key,
    name: s.name,
    provider: s.provider,
    model: s.model,
    scope: stageScope(s),
    gate: s.gate ?? false,
  }))
  return { runId, stages: mapped }
}
