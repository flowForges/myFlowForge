import type { PermissionMode } from '@shared/permissions'
import type { ArtifactRef } from '../orchestrator/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { StagePlan } from './machine'
import { runWorkOrder, type WorkOrder, type WorkOrderOutcome, type RunWorkOrderDeps } from './workOrder'

export interface StageInput {
  stage: StagePlan
  workspacePath: string
  projects: DevelopProject[]
  upstream: ArtifactRef[]
  buildPrompt: (o: { stageKey: string; project?: string; cwd: string; upstream: ArtifactRef[] }) => string
  permissionMode?: PermissionMode
}

export function buildWorkOrders(input: StageInput): WorkOrder[] {
  const { stage, workspacePath, projects, upstream, buildPrompt, permissionMode } = input
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
