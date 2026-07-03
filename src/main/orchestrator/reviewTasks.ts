import type { ReviewConfig, ReviewLens } from '../config/schema'

// One reviewer the review stage will spawn. PURE description; no process is started here.
//  - id   : the AgentRuntime id (also FORGE_AGENT_ID).
//  - name : the card title (project name for per-project; '代码 CR' for single).
//  - cwd  : where the reviewer runs (project worktree for per-project; workspace root otherwise).
//  - lens : the review视角 for multi-lens (undefined for single / per-project).
export interface ReviewerTask {
  id: string
  name: string
  cwd: string
  lens?: ReviewLens
}

export interface ReviewProject { name: string; cwd: string }
export interface ReviewRoot { name: string; cwd: string }

const REVIEW_STAGE_NAME = '代码 CR'

// Resolve the review stage's CR config + project list into the concrete reviewer list.
// Mirrors the develop per-project fan-out so orchestrator can reuse the same Promise.all path.
export function buildReviewTasks(cfg: ReviewConfig, projects: ReviewProject[], root: ReviewRoot): ReviewerTask[] {
  const single = (): ReviewerTask[] => [{ id: 'review', name: REVIEW_STAGE_NAME, cwd: root.cwd }]

  if (cfg.mode === 'single') return single()

  if (Array.isArray(cfg.reviewers) && cfg.reviewers.length > 0) {
    return cfg.reviewers.map(lens => ({ id: `review:workspace:${lens}`, name: REVIEW_STAGE_NAME, cwd: root.cwd, lens }))
  }

  const scope = cfg.scope ?? 'per-project'
  if (scope === 'per-project') {
    if (projects.length === 0) return single()
    return projects.map(p => ({ id: `review:${p.name}`, name: p.name, cwd: p.cwd }))
  }

  return single()
}
