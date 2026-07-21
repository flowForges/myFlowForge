import { stageScope, type StageSpec } from './runTypes'
import { stageBasePrompt } from '../config/schema'
import type { RunPlan, StagePlan } from './machine'
import type { Plugin } from '../../shared/plugin'
import { tempBranchName } from './tempBranch'

// Stages that pause on a human review gate (方案门) by DEFAULT when the stage config carries no
// explicit `gate` — mirrors the legacy orchestrator's REVIEW_GATED_STAGES / stageGated (orchestrator.
// ts). v1 = design only: the user MUST approve the 技术方案 before code development proceeds. Kept as
// a run2-owned constant (not imported from orchestrator/, per the D7 decoupling goal) so deleting the
// orchestrator later doesn't touch this. IMPORTANT: without this default, `gate: s.gate ?? false`
// silently un-gated a standard workflow's design stage (the wizard/resolveStages only write `gate`
// when the user explicitly toggles it), so the design gate never fired and the run auto-advanced into
// 代码开发 — the user never got to see or approve the produced 技术方案.
const DEFAULT_GATED_STAGES = new Set(['design'])

// Resolves the prompt actually sent to a stage's agent: built-in stages have a constant base
// (STAGE_PROMPTS), and any stage-level `prompt` is appended after it (custom stages have no base,
// so their `prompt` is the full text as-is). Mirrors the old orchestrator's STAGE_PROMPTS[key] wiring.
export function planFromStages(runId: string, stages: StageSpec[], hooks?: Plugin[]): RunPlan {
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
      // Explicit config wins; otherwise design (and any future DEFAULT_GATED_STAGES member) gates by
      // default — matches the orchestrator's stageGated so a standard workflow's 方案门 actually fires.
      gate: s.gate ?? DEFAULT_GATED_STAGES.has(s.key),
      prompt,
      // ②多镜头CR: carry the review stage's fan-out config into the plan so fanout.buildWorkOrders can
      // fan it into per-lens reviewers (see reviewFanout.ts). undefined for every non-review stage.
      review: s.review,
    }
  })
  // P4-2: every RunPlan gets its run's temp-branch name stamped in (single value shared across all
  // participating projects' repos — only cwd differs per project). This is the ONE place all current
  // plan-building callers (resolveStartPlan, buildLaunchPlan, the raw run2:start channel) funnel
  // through, so RunExecPanel's header always has a real value instead of the '—' placeholder.
  // ③stage hooks: attach the run's woven hooks (only when non-empty, so a hook-less run's plan is
  // byte-for-byte what it was before this existed). The raw run2:start channel passes none.
  return { runId, stages: mapped, tempBranch: tempBranchName(runId), ...(hooks && hooks.length ? { hooks } : {}) }
}
