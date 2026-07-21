import type { ReviewConfig, ReviewLens } from '@shared/types'
import { REVIEW_LENS_LABELS, REVIEW_LENS_FOCUS } from '@shared/types'
import type { StagePlan } from './machine'
import type { WorkOrder, WorkOrderOutcome } from './workOrder'
import type { PermissionMode } from '@shared/permissions'

// ②多镜头CR: run2-owned code-review fan-out (migrated from the legacy orchestrator's reviewTasks.ts +
// reviewReport.ts, kept independent of orchestrator/ so deleting it later doesn't touch run2). When the
// review stage's config is lens mode (mode:'parallel', reviewers = ReviewLens[]), the stage fans out
// into ONE reviewer per lens — each审 the whole run's aggregated changes at the workspace root through a
// single视角 (正确性/安全/性能/规范) — instead of run2's plain root (single) / per-project shapes.

/**
 * The ordered lens list for a review config, or null when this stage should NOT fan out per-lens.
 * Lens mode = mode 'parallel' AND `reviewers` is a non-empty ReviewLens[] (an array of strings, not a
 * number — a bare number is the reserved "parallelism" shape, not a视角 list). Everything else
 * (mode 'single', parallel-with-a-number, parallel-with-no-reviewers, or no review config at all)
 * returns null so fanout.ts falls back to its normal root/per-project shapes.
 */
export function reviewLenses(cfg: ReviewConfig | undefined): ReviewLens[] | null {
  if (!cfg || cfg.mode !== 'parallel') return null
  const r = cfg.reviewers
  if (!Array.isArray(r) || r.length === 0) return null
  return r
}

/**
 * Whether a stage should fan out into per-lens reviewers: it has a lens config AND is root-scope.
 * The scope guard is load-bearing — the lens reviewers all run at the workspace root, so this must
 * NOT hijack a PER-PROJECT stage (e.g. `develop`) that happens to carry a stray review config: that
 * would silently drop its per-project worktree fan-out. A review stage is root-scope by default
 * (STAGE defaults), so lens review still triggers for it; a per-project stage with a lens config
 * falls through to its normal per-project shape instead. fanout.buildWorkOrders,
 * runExecAdapter.buildStageRuntimes, and RunController's review gate body ALL gate on this same
 * predicate so they can never disagree about whether a stage is lens-fanned.
 */
export function isLensReviewStage(stage: { scope: 'root' | 'per-project'; review?: ReviewConfig }): boolean {
  return stage.scope === 'root' && reviewLenses(stage.review) !== null
}

export function reviewLaneId(stageKey: string, lens: ReviewLens): string { return `${stageKey}:workspace:${lens}` }
export function reviewLaneName(stageName: string, lens: ReviewLens): string { return `${stageName} · ${REVIEW_LENS_LABELS[lens]}` }

/** The per-lens focus block appended to a reviewer's prompt so it審 exactly one视角 (not everything). */
export function lensDirective(lens: ReviewLens): string {
  return `\n【本次评审视角】只聚焦「${REVIEW_LENS_LABELS[lens]}」:${REVIEW_LENS_FOCUS[lens]}。\n只报本视角发现,明确区分「必须修复」与「建议项」;其它视角交给并行的其它评审员,不要重复。\n`
}

/**
 * Build the per-lens reviewer work orders for a lens-mode review stage. Every reviewer runs at the
 * workspace root (they审 the run's aggregated changes, not one project's worktree), carries its own
 * `lens`, and gets a lens-scoped prompt (buildPrompt is handed the lens so RunController.buildPrompt
 * appends lensDirective). Deterministic order = REVIEW_LENSES order (via reviewLenses).
 */
export function buildReviewOrders(
  stage: StagePlan,
  workspacePath: string,
  buildPrompt: (o: { stageKey: string; cwd: string; lens?: ReviewLens }) => string,
  permissionMode?: PermissionMode,
): WorkOrder[] {
  const lenses = reviewLenses(stage.review)
  if (!lenses) return []
  return lenses.map((lens) => ({
    id: reviewLaneId(stage.key, lens),
    stageKey: stage.key,
    name: reviewLaneName(stage.name, lens),
    provider: stage.provider,
    model: stage.model,
    cwd: workspacePath,
    prompt: buildPrompt({ stageKey: stage.key, cwd: workspacePath, lens }),
    permissionMode,
    lens,
  }))
}

/**
 * Deterministic (zero-LLM), idempotent consolidation of a lens-mode review stage's reviewer outcomes
 * into one "多视角代码评审汇总" — grouped by lens in the reviewers' own order, showing each lens's
 * reported findings (or its failure). Used as the review stage's gate body (RunController) so the user
 * sees every视角's verdict in one place before 通过/打回. Mirrors the old orchestrator's
 * buildReviewReport, but reads WorkOrderOutcome instead of AgentRuntime logs.
 */
export function composeReviewReport(stageName: string, outcomes: WorkOrderOutcome[]): string {
  const head = `${stageName}汇总 · ${outcomes.length} 个视角`
  const blocks = outcomes.map((o) => {
    const label = o.order.lens ? REVIEW_LENS_LABELS[o.order.lens] : o.order.name
    if (o.status !== 'ok' || !o.result) return `### ${label}\n  ✗ ${o.error ?? '未完成'}`
    const body = o.result.summary?.trim() || '（无交接）'
    return `### ${label}\n${body}`
  })
  return `${head}\n\n${blocks.join('\n\n')}`
}
