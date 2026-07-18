// P4-A launcher: server-side resolution for the workflow-picker button. Pure functions (no IO) so
// they're unit-testable without booting Electron; run2Handlers.ts wires them to the store's
// readWorkspace/readWorkflows/readCustomStages + Run2Manager.start.
//
// Fixes a real bug: the P3-B temp button read `ws.stages`, which is PERMANENTLY [] for any workspace
// created/edited under the multi-workflow model — the real stages live in `ws.workflows[].stages`
// (or, if that workflow itself has none stashed, fall back to the global workflow template via
// resolveWorkflowStages). Same resolution pattern as proposeRun.ts / resumeWorkspace in handlers.ts.
import { join } from 'node:path'
import type { PermissionMode } from '@shared/permissions'
import type { Workspace, Workflow, CustomStage } from '../config/schema'
import { stageName, workflowDisplayName } from '../config/schema'
import { indexCustomStages } from '../../shared/customStages'
import { pickWorkspaceWorkflow, resolveWorkflowStages } from '../workspace/resolveStages'
import { planFromStages } from './planFromStages'
import type { RunPlan } from './machine'
import type { StageSpec, DevelopProject } from '../orchestrator/orchestrator'

export interface LaunchInfo {
  workflows: { id: string; name: string }[]
  projects: { name: string; cwd: string; provider?: string; model?: string }[]
}

// Lists a workspace's named workflows (id + display name) and its projects (name + absolute worktree
// cwd + per-project develop provider/model override, if set) — everything the launcher picker needs
// to render, resolved server-side so the renderer never has to know the on-disk workspace shape.
export function buildLaunchInfo(ws: Workspace): LaunchInfo {
  return {
    workflows: ws.workflows.map((w) => ({ id: w.id, name: workflowDisplayName(w.name) })),
    projects: ws.projects.map((p) => {
      const name = p.name || p.repoId
      return { name, cwd: join(ws.path, name), provider: p.provider || undefined, model: p.model || undefined }
    }),
  }
}

export interface StartWorkflowOpts {
  workspacePath: string
  workflowId: string
  projectNames: string[]
  task?: string
  runId: string
  permissionMode?: PermissionMode
}

// Resolves the PICKED workflow's stages (falling back to the global template when the workspace's own
// copy is empty — same as resolveWorkflowStages elsewhere) into a RunPlan, and narrows the workspace's
// projects down to the ones the caller selected. Throws a clear error if the workflow id doesn't match
// any of the workspace's named workflows, or if resolution yields zero stages (nothing to run).
export function resolveStartPlan(
  ws: Workspace,
  workflows: Workflow[],
  custom: CustomStage[],
  opts: StartWorkflowOpts,
): { plan: RunPlan; projects: DevelopProject[]; task?: string; permissionMode?: PermissionMode } {
  const wf = pickWorkspaceWorkflow(ws, opts.workflowId)
  // pickWorkspaceWorkflow silently falls back to workflows[0] when the id doesn't match (its contract
  // for the "auto-decide" caller) — the launcher needs an explicit failure instead when the caller asked
  // for a specific, non-existent workflow id.
  if (!wf || wf.id !== opts.workflowId) throw new Error(`未知工作流: ${opts.workflowId}`)

  const custIndex = indexCustomStages(custom)
  const resolved = resolveWorkflowStages(wf, workflows, custIndex)
  if (resolved.length === 0) throw new Error(`工作流「${workflowDisplayName(wf.name)}」没有可执行阶段`)

  const stageSpecs: StageSpec[] = resolved.map((s) => ({
    key: s.key,
    name: stageName(s.key, s.name),
    provider: s.provider,
    model: s.model,
    scope: s.scope,
    gate: s.gate,
    prompt: s.prompt,
  }))
  const plan = planFromStages(opts.runId, stageSpecs)

  const projects = buildLaunchInfo(ws).projects.filter((p) => opts.projectNames.includes(p.name))

  return { plan, projects, task: opts.task, permissionMode: opts.permissionMode }
}
