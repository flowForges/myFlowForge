import { stageScope, type StageSpec } from '../orchestrator/orchestrator'
import { stageBasePrompt } from '../config/schema'
import type { RunPlan, StagePlan } from './machine'

// Resolves the prompt actually sent to a stage's agent: built-in stages have a constant base
// (STAGE_PROMPTS), and any stage-level `prompt` is appended after it (custom stages have no base,
// so their `prompt` is the full text as-is). Mirrors the old orchestrator's STAGE_PROMPTS[key] wiring.
export function planFromStages(runId: string, stages: StageSpec[]): RunPlan {
  const mapped: StagePlan[] = stages.map((s) => {
    const base = stageBasePrompt(s.key)
    const custom = s.prompt
    const prompt = custom ? (base ? base + '\n\n' + custom : custom) : base
    return {
      key: s.key,
      name: s.name,
      provider: s.provider,
      model: s.model,
      scope: stageScope(s),
      gate: s.gate ?? false,
      prompt,
    }
  })
  return { runId, stages: mapped }
}
