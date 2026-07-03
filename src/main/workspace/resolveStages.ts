import type { Workspace, WsStage, Workflow, ReviewConfig } from '../config/schema'

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
export function resolveStages(ws: Pick<Workspace, 'stages' | 'workflowId'>, workflows: Workflow[]): WsStage[] {
  if (ws.stages && ws.stages.length > 0) return withReviewDefaults(ws.stages)
  const wf = workflows.find(w => w.id === ws.workflowId)
  if (!wf) return []
  return withReviewDefaults(wf.stages.map(s => ({
    key: s.key, provider: s.defaultAgent, model: s.defaultModel,
    ...(wf.stagePrompts?.[s.key] ? { prompt: wf.stagePrompts[s.key] } : {}),
  })))
}
