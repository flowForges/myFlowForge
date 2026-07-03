import { join } from 'node:path'
import { STAGE_NAMES, type StageKey, type Workspace } from '../config/schema'
import type { StartRunOpts } from '../orchestrator/orchestrator'

// Pure reconstructor: rebuild a StartRunOpts from a persisted Workspace so a run can be
// re-run later (SP-C) without knownProjects or the workflow def. Equivalent in shape to the
// startRunOpts createWorkspace returned at creation time (worktrees already exist on disk).
export function workspaceToStartRunOpts(ws: Workspace, task?: string): StartRunOpts {
  return {
    runId: `run-${ws.name}`,
    workspaceName: ws.name,
    workspacePath: ws.path,
    task,
    plugins: ws.plugins ?? [],
    stepPlugins: ws.stepPlugins ?? [],
    stages: ws.stages.map(s => ({
      key: s.key, name: STAGE_NAMES[s.key as StageKey] ?? s.key, provider: s.provider, model: s.model,
      review: s.review, ...(s.prompt ? { prompt: s.prompt } : {}),
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
