import { join } from 'node:path'
import { mirrorPath, expandTilde } from '../config/paths'
import { ensureMirror, addWorktree } from '../git/worktree'
import { writeWorkspace, registerWorkspace, readWorkspace } from '../config/store'
import { ensureWorkspaceSkill } from '../skills/installSkill'
import { STAGE_NAMES, type StageKey, type Project, type Workspace } from '../config/schema'
import type { StartRunOpts, StageSpec, DevelopProject } from '../orchestrator/orchestrator'
import type { CreateWorkspaceOpts } from '@shared/types'

export interface CreateWorkspaceResult { workspace: Workspace; startRunOpts: StartRunOpts }

// Provision one project's git worktree under the workspace: ensure the bare mirror, then add the
// worktree at <wsPath>/<project name>. Shared by createWorkspace (all projects), editWorkspace
// (new projects only) and runWorkspaceSetup (the setup-hook path). Returns the worktree path.
export async function provisionWorktree(proj: Project, branch: string, wsPath: string, proxy: string): Promise<string> {
  const mirror = mirrorPath(proj.id)
  const worktreePath = join(wsPath, proj.name)
  await ensureMirror({ mirror, repoUrl: proj.repoUrl, proxy })
  await addWorktree({ mirror, worktreePath, branch, baseBranch: proj.defaultBranch })
  return worktreePath
}

// Assemble the persisted Workspace record from create opts. Factored out so createWorkspace and
// runWorkspaceSetup produce byte-identical workspace.json — the SAME name-defaulting + full
// resolved-config persistence (SP-C) lives here, in one place. `opts.path` must already be expanded.
export function buildWorkspaceRecord(opts: CreateWorkspaceOpts, byId: Map<string, Project>): Workspace {
  return {
    name: opts.name,
    path: opts.path,
    workflowId: opts.workflowId,
    stages: opts.stages.map(s => ({ key: s.key as StageKey, provider: s.provider, model: s.model, ...(s.prompt ? { prompt: s.prompt } : {}) })),
    projects: opts.projects.map(sel => {
      const proj = byId.get(sel.repoId)!
      // Default name to repoId when the known project has no display name — keeps persisted records
      // from ever storing name:'' (which would later break per-project cwd + agent labels).
      return { repoId: sel.repoId, name: proj.name || sel.repoId, branch: sel.branch, provider: sel.provider ?? '', model: sel.model ?? '' }
    }),
    status: 'idle',
    plugins: opts.plugins ?? [],
    stepPlugins: opts.stepPlugins ?? []
  }
}

// Assemble StartRunOpts from create opts + the provisioned developProjects. Shared by both create
// paths so a run can be (re)built identically regardless of whether setup hooks ran.
export function buildStartRunOpts(opts: CreateWorkspaceOpts, developProjects: DevelopProject[]): StartRunOpts {
  const stages: StageSpec[] = opts.stages.map(s => ({
    key: s.key, name: STAGE_NAMES[s.key as StageKey] ?? s.key, provider: s.provider, model: s.model,
    ...(s.prompt ? { prompt: s.prompt } : {})
  }))
  return {
    runId: `run-${opts.name}`,
    workspaceName: opts.name,
    workspacePath: opts.path,
    stages,
    developProjects
  }
}

export async function createWorkspace(args: {
  opts: CreateWorkspaceOpts
  knownProjects: Project[]
  proxy: string
}): Promise<CreateWorkspaceResult> {
  const { knownProjects, proxy } = args
  // Expand `~` once, up front, so the workspace is created at a real absolute path
  // (not a literal `~` dir under the process cwd) and stored that way everywhere.
  const opts = { ...args.opts, path: expandTilde(args.opts.path) }
  const byId = new Map(knownProjects.map(p => [p.id, p]))

  const developProjects: DevelopProject[] = []
  for (const sel of opts.projects) {
    const proj = byId.get(sel.repoId)
    if (!proj) throw new Error(`未知项目: ${sel.repoId}`)
    const worktreePath = await provisionWorktree(proj, sel.branch, opts.path, proxy)
    developProjects.push({ name: proj.name || sel.repoId, cwd: worktreePath, provider: sel.provider, model: sel.model })
  }

  // Persist the FULL resolved workflow config so the run can be re-built/re-run from
  // workspace.json alone (SP-C), without re-querying knownProjects or the workflow def.
  const workspace = buildWorkspaceRecord(opts, byId)
  writeWorkspace(workspace)
  ensureWorkspaceSkill(opts.path)        // install the workflow-trigger skill into the workspace
  registerWorkspace(opts.name, opts.path)

  const startRunOpts = buildStartRunOpts(opts, developProjects)
  return { workspace, startRunOpts }
}

// Edit an existing workspace's persisted config in place: rename, adjust stages/models, and ADD
// projects (existing ones are locked in the UI and never removed here). Path is the identity and is
// not changed. Only newly-added projects get a worktree; existing ones already have theirs on disk.
export async function editWorkspace(args: {
  path: string
  opts: CreateWorkspaceOpts
  knownProjects: Project[]
  proxy: string
}): Promise<Workspace> {
  const path = expandTilde(args.path)
  const { opts, knownProjects, proxy } = args
  const existing = readWorkspace(path)
  if (!existing) throw new Error(`工作区不存在: ${path}`)

  const byId = new Map(knownProjects.map(p => [p.id, p]))
  const existingRepoIds = new Set(existing.projects.map(p => p.repoId))

  for (const sel of opts.projects) {
    if (existingRepoIds.has(sel.repoId)) continue          // worktree already on disk
    const proj = byId.get(sel.repoId)
    if (!proj) throw new Error(`未知项目: ${sel.repoId}`)
    await provisionWorktree(proj, sel.branch, path, proxy)
  }

  const workspace: Workspace = {
    name: opts.name,
    path,
    workflowId: opts.workflowId,
    stages: opts.stages.map(s => ({ key: s.key as StageKey, provider: s.provider, model: s.model, ...(s.prompt ? { prompt: s.prompt } : {}) })),
    projects: opts.projects.map(sel => {
      const proj = byId.get(sel.repoId)
      const name = proj?.name || existing.projects.find(p => p.repoId === sel.repoId)?.name || sel.repoId
      return { repoId: sel.repoId, name, branch: sel.branch, provider: sel.provider ?? '', model: sel.model ?? '' }
    }),
    status: existing.status,
    plugins: opts.plugins ?? existing.plugins ?? [],
    stepPlugins: opts.stepPlugins ?? existing.stepPlugins ?? []
  }
  writeWorkspace(workspace)
  registerWorkspace(opts.name, path)
  ensureWorkspaceSkill(path)
  return workspace
}
