import { join } from 'node:path'
import { stageName, type Workspace } from '../config/schema'
import type { StartRunOpts } from '../run/runTypes'

// Pure reconstructor: rebuild a StartRunOpts from a persisted Workspace so a run can be
// re-run later (SP-C) without knownProjects or the workflow def. Equivalent in shape to the
// startRunOpts createWorkspace returned at creation time (worktrees already exist on disk).
export function workspaceToStartRunOpts(ws: Workspace, task?: string, wf?: { id: string; name: string }): StartRunOpts {
  return {
    runId: `run-${ws.name}`,
    workspaceName: ws.name,
    workspacePath: ws.path,
    task,
    workflowId: wf?.id,
    workflowName: wf?.name,
    plugins: ws.plugins ?? [],
    stepPlugins: ws.stepPlugins ?? [],
    stages: ws.stages.map(s => ({
      key: s.key, name: stageName(s.key, s.name), provider: s.provider, model: s.model,
      // Every stage pauses on a review gate by default (approve / 打回重做 / 终止); an explicit
      // per-stage gate flag wins. Custom-stage behavior flags flow straight through.
      gate: s.gate ?? true,
      review: s.review, ...(s.prompt ? { prompt: s.prompt } : {}),
      ...(s.scope ? { scope: s.scope } : {}),
      ...(s.summary !== undefined ? { summary: s.summary } : {}),
      ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
      ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
    })),
    developProjects: ws.projects.map(p => {
      // Old/pre-SP-A workspace.json stored only {repoId,branch}; name parses as ''. The worktree
      // dir on disk is named by repoId, so fall back to repoId for BOTH the agent label and the
      // cwd (join(path,'') would otherwise resolve to the workspace root, not the per-project worktree).
      const pname = p.name || p.repoId
      return { name: pname, cwd: join(ws.path, pname), provider: p.provider || undefined, model: p.model || undefined }
    })
  }
}
