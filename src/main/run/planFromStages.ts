import { stageScope, type StageSpec } from '../orchestrator/orchestrator'
import { stageBasePrompt } from '../config/schema'
import type { RunPlan, StagePlan } from './machine'
import { tempBranchName } from './tempBranch'

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
  // P4-2: every RunPlan gets its run's temp-branch name stamped in (single value shared across all
  // participating projects' repos — only cwd differs per project). This is the ONE place all current
  // plan-building callers (resolveStartPlan, buildLaunchPlan, the raw run2:start channel) funnel
  // through, so RunExecPanel's header always has a real value instead of the '—' placeholder.
  return { runId, stages: mapped, tempBranch: tempBranchName(runId) }
}
