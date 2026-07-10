import type { Workspace, WsStage, Workflow, ReviewConfig } from '../config/schema'
import { resolveStages as resolveLibRefs, type StageDefById } from '../../shared/customStages'

// Default CR mode when a review stage carries no explicit review config (user-confirmed default).
const DEFAULT_REVIEW_CONFIG: ReviewConfig = { mode: 'parallel', scope: 'per-project' }

// Fill the review stage's default CR config when absent; leave every other stage and any explicit
// review config untouched. Returns a new array (does not mutate the input stages).
function withReviewDefaults(stages: WsStage[]): WsStage[] {
  return stages.map(s => (s.key === 'review' && !s.review ? { ...s, review: DEFAULT_REVIEW_CONFIG } : s))
}

// Stages persisted on the workspace win; for pre-SP-A workspaces (empty stages) fall back to the
// workflow definition (by workflowId), mapping defaultAgent/defaultModel → provider/model.
// In both paths the review stage gets a default CR config (parallel/per-project) when none is set.
export function resolveStages(ws: Pick<Workspace, 'stages' | 'workflowId'>, workflows: Workflow[], customStagesById: StageDefById = {}): WsStage[] {
  if (ws.stages && ws.stages.length > 0) return withReviewDefaults(ws.stages)
  const wf = workflows.find(w => w.id === ws.workflowId)
  if (!wf) return []
  // Resolve any library-referenced (libId) template stages against the global custom-stage library so
  // an old workspace (empty ws.stages) materializes the CURRENT shared definition, not a stale cache.
  return withReviewDefaults(resolveLibRefs(wf.stages, customStagesById).map(s => ({
    key: s.key, provider: s.defaultAgent, model: s.defaultModel,
    // Carry a custom stage's identity + behavior flags from the template onto the resolved WsStage.
    ...(s.name ? { name: s.name } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.gate !== undefined ? { gate: s.gate } : {}),
    ...(s.review ? { review: s.review } : {}),
    ...(s.summary !== undefined ? { summary: s.summary } : {}),
    ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
    ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
    // prompt: the template's per-stage append (stagePrompts) OR the stage's own prompt (custom body).
    ...((s.prompt ?? wf.stagePrompts?.[s.key]) ? { prompt: s.prompt ?? wf.stagePrompts[s.key] } : {}),
  })))
}
