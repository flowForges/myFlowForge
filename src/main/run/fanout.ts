import type { PermissionMode } from '@shared/permissions'
import type { ArtifactRef } from './runTypes'
import type { DevelopProject } from './runTypes'
import type { StagePlan } from './machine'
import { runWorkOrder, type WorkOrder, type WorkOrderOutcome, type RunWorkOrderDeps } from './workOrder'
import { isLensReviewStage, buildReviewOrders } from './reviewFanout'
import type { ReviewLens } from '@shared/types'

export interface StageInput {
  stage: StagePlan
  workspacePath: string
  projects: DevelopProject[]
  upstream: ArtifactRef[]
  // `lens` (②多镜头CR): set only for a multi-lens review reviewer, so RunController.buildPrompt appends
  // the per-lens focus directive. Absent for every other order.
  buildPrompt: (o: { stageKey: string; project?: string; cwd: string; upstream: ArtifactRef[]; lens?: ReviewLens }) => string
  permissionMode?: PermissionMode
}

export function buildWorkOrders(input: StageInput): WorkOrder[] {
  const { stage, workspacePath, projects, upstream, buildPrompt, permissionMode } = input
  // ②多镜头CR: a root-scope lens-mode review stage fans out into one reviewer per视角 at the workspace
  // root. Gated on isLensReviewStage (root scope + lens config) so a stray lens config on a PER-PROJECT
  // stage (e.g. develop) can't hijack its per-project fan-out — see isLensReviewStage's doc. Non-lens
  // review configs (single / per-project) fall through to the normal shapes below unchanged.
  if (isLensReviewStage(stage)) {
    return buildReviewOrders(
      stage, workspacePath,
      ({ stageKey, cwd, lens }) => buildPrompt({ stageKey, cwd, upstream, lens }),
      permissionMode,
    )
  }
  if (stage.scope === 'root') {
    return [{
      id: `${stage.key}:root`, stageKey: stage.key, name: stage.name,
      provider: stage.provider, model: stage.model, cwd: workspacePath,
      prompt: buildPrompt({ stageKey: stage.key, cwd: workspacePath, upstream }),
      permissionMode,
    }]
  }
  return projects.map((p) => ({
    id: `${stage.key}:${p.name}`, stageKey: stage.key, name: stage.name, project: p.name,
    provider: p.provider || stage.provider, model: p.model || stage.model, cwd: p.cwd,
    prompt: buildPrompt({ stageKey: stage.key, project: p.name, cwd: p.cwd, upstream }),
    permissionMode,
  }))
}

export async function runStage(
  orders: WorkOrder[],
  deps: (o: WorkOrder) => RunWorkOrderDeps,
): Promise<WorkOrderOutcome[]> {
  // runWorkOrder never throws → plain Promise.all is safe and gives allSettled semantics.
  return Promise.all(orders.map((o) => runWorkOrder(o, deps(o))))
}
