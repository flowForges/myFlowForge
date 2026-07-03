import type { StageSpec } from './orchestrator'
import { REVIEW_GATED_STAGES } from './orchestrator'
import type { HandoffBrief } from './brief'
import type { RunState, StageRuntime } from '@shared/types'

export interface ResumePlan {
  // Stages that already finished ok — replayed into the run purely so the UI shows them done.
  completedStages: StageRuntime[]
  // The stages still to run, in order, with any cross-model override applied.
  remainingSpecs: StageSpec[]
  // Handoff summaries of the completed stages, seeded so the resumed stages get prior context —
  // this is what makes cross-model resume work (text summaries are provider-agnostic).
  priorBriefs: HandoffBrief[]
}

// Decide how to resume a cancelled/failed run: replay the stages that finished ok, and re-run from
// the first stage that did NOT complete (errored, or never started). Returns null when there's
// nothing left to run. `getHandoff(agentId)` supplies the persisted handoff summary for an agent.
export function planResume(
  prior: RunState,
  allSpecs: StageSpec[],
  getHandoff: (agentId: string) => string | undefined,
  modelOverride?: { provider?: string; model?: string },
  // Whether a gated stage's review gate was APPROVED. Defaults to always-true so callers that don't
  // track gates keep the legacy behaviour; the real caller reads the persisted gate-approval flag.
  gateApproved: (stageKey: string) => boolean = () => true,
): ResumePlan | null {
  const byKey = new Map(prior.stages.map(s => [s.key, s]))
  // The resume point = first spec whose prior stage is absent, not 'ok', OR a gated stage that
  // finished but whose review gate was never approved (user cancelled at the confirm). Re-running from
  // there means the design gate fires again instead of resuming straight into code with an un-approved
  // plan. Stages run sequentially, so everything from the resume point onward re-runs.
  const resumeIdx = allSpecs.findIndex(spec => {
    const st = byKey.get(spec.key)
    if (st?.state !== 'ok') return true
    if (REVIEW_GATED_STAGES.has(spec.key) && !gateApproved(spec.key)) return true
    return false
  })
  if (resumeIdx === -1) return null // every stage completed (and gated stages approved) — nothing to resume

  const completedStages = allSpecs
    .slice(0, resumeIdx)
    .map(spec => byKey.get(spec.key))
    .filter((s): s is StageRuntime => !!s)

  const priorBriefs: HandoffBrief[] = []
  for (const stage of completedStages) {
    for (const agent of stage.agents) {
      const summary = getHandoff(agent.id)
      if (summary) priorBriefs.push({ agentName: agent.name, summary, artifacts: [] })
    }
  }

  const remainingSpecs = allSpecs.slice(resumeIdx).map(spec => ({
    ...spec,
    ...(modelOverride?.provider ? { provider: modelOverride.provider } : {}),
    ...(modelOverride?.model ? { model: modelOverride.model } : {}),
  }))

  return { completedStages, remainingSpecs, priorBriefs }
}
