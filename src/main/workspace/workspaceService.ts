import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mirrorPath, expandTilde } from '../config/paths'
import { ensureMirror, addWorktree, resolveBaseBranch, removeWorktree } from '../git/worktree'
import { writeWorkspace, registerWorkspace, readWorkspace, setProjectDefaultBranch } from '../config/store'
import { removeWorkspaceSkill } from '../skills/installSkill'
import { readWorkspaceMemory, writeWorkspaceMemory, mergeMemory } from '../chat/memory/memoryStore'
import { stageName, type Project, type Workspace } from '../config/schema'
import type { StartRunOpts, StageSpec, DevelopProject } from '../run/runTypes'
import type { AgentProvider } from '../agents/types'
import type { CreateWorkspaceOpts, CreateWorkspaceStage, SetupEvent, WsStage } from '@shared/types'
import { runStepHook } from './stepHooks'

// Persist a create-time stage as a resolved WsStage, carrying its custom identity + behavior flags
// (name/scope/gate/review/summary/projectAgent/producesDoc) so custom stages survive to workspace.json.
function toWsStage(s: CreateWorkspaceStage): WsStage {
  return {
    key: s.key, provider: s.provider, model: s.model,
    ...(s.prompt ? { prompt: s.prompt } : {}),
    ...(s.name ? { name: s.name } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.gate !== undefined ? { gate: s.gate } : {}),
    ...(s.review ? { review: s.review } : {}),
    ...(s.summary !== undefined ? { summary: s.summary } : {}),
    ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
    ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
  }
}

export interface CreateWorkspaceResult { workspace: Workspace; startRunOpts: StartRunOpts }

// Provision one project's git worktree under the workspace: ensure the bare mirror, then add the
// worktree at <wsPath>/<project name>. Shared by createWorkspace (all projects), editWorkspace
// (new projects only) and runWorkspaceSetup (the setup-hook path). Returns the worktree path.
export async function provisionWorktree(proj: Project, branch: string, wsPath: string, proxy: string, signal?: AbortSignal): Promise<string> {
  const mirror = mirrorPath(proj.id)
  const worktreePath = join(wsPath, proj.name)
  await ensureMirror({ mirror, repoUrl: proj.repoUrl, proxy, signal })
  // The project's stored default branch may be wrong (mistyped at import). Resolve against the real
  // mirror so a bad base can't fail workspace creation; if it was corrected, persist it back so
  // future workspaces + the project list show the real branch.
  const base = await resolveBaseBranch(mirror, proj.defaultBranch)
  if (base !== proj.defaultBranch) setProjectDefaultBranch(proj.id, base)
  await addWorktree({ mirror, worktreePath, branch, baseBranch: base, signal })
  return worktreePath
}

// Assemble the persisted Workspace record from create opts. Factored out so createWorkspace and
// runWorkspaceSetup produce byte-identical workspace.json — the SAME name-defaulting + full
// resolved-config persistence (SP-C) lives here, in one place. `opts.path` must already be expanded.
export function buildWorkspaceRecord(opts: CreateWorkspaceOpts, byId: Map<string, Project>): Workspace {
  return {
    name: opts.name,
    path: opts.path,
    workflowId: '',   // legacy 迁移种子 — 新文件走下面的 workflows
    stages: [],        // legacy 迁移种子
    workflows: opts.workflows.map(wf => ({ id: wf.id, name: wf.name, stages: wf.stages.map(toWsStage) })),
    projects: opts.projects.map(sel => {
      // buildWorkspaceRecord runs BEFORE the provision loop's "未知项目" guard, so a selected project
      // that isn't in the known map (e.g. projects.json missing, or restoring a partial whose project
      // is no longer registered) must NOT crash here with `undefined.name` — fall back to the repoId.
      // The provision loop then throws the clear 未知项目 error.
      const proj = byId.get(sel.repoId)
      return { repoId: sel.repoId, name: proj?.name || sel.repoId, branch: sel.branch, provider: sel.provider ?? '', model: sel.model ?? '' }
    }),
    status: 'idle',
    plugins: opts.plugins ?? [],
    stepPlugins: opts.stepPlugins ?? [],
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
  }
}

// Seed the workspace memory's `## 建区目的` section from the create-wizard purpose input. Runs once at
// create time; later distillation updates the same section in place (mergeMemory dedups by heading).
// Blank purpose is a no-op. Best-effort — never let a memory-seed failure block workspace creation.
export function seedPurposeMemory(wsPath: string, purpose: string | undefined): void {
  const p = (purpose ?? '').trim()
  if (!p) return
  try { writeWorkspaceMemory(wsPath, mergeMemory(readWorkspaceMemory(wsPath), `## 建区目的\n${p}`)) } catch { /* seeding is best-effort */ }
}

// Assemble StartRunOpts from create opts + the provisioned developProjects. Shared by both create
// paths so a run can be (re)built identically regardless of whether setup hooks ran. A workspace may
// carry several workflows now — the stashed pending-start run defaults to the FIRST one; the chat/
// forge_propose_plan flow picks a different workflowId explicitly for later runs.
export function buildStartRunOpts(opts: CreateWorkspaceOpts, developProjects: DevelopProject[]): StartRunOpts {
  const wf = opts.workflows[0]
  const stages: StageSpec[] = (wf?.stages ?? []).map(s => ({
    key: s.key, name: stageName(s.key, s.name), provider: s.provider, model: s.model,
    // Every stage pauses on a review gate by default (approve / 打回重做 / 终止); an explicit per-stage
    // gate flag wins. Custom-stage behavior flags flow straight through to the orchestrator.
    gate: s.gate ?? true,
    review: s.review,
    ...(s.prompt ? { prompt: s.prompt } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.summary !== undefined ? { summary: s.summary } : {}),
    ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
    ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
  }))
  return {
    runId: `run-${opts.name}`,
    workspaceName: opts.name,
    workspacePath: opts.path,
    workflowId: wf?.id,
    workflowName: wf?.name,
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
  removeWorkspaceSkill(opts.path)        // pure chat (P5 T1): no forge-workflow skill anymore
  seedPurposeMemory(opts.path, opts.purpose)  // seed 建区目的 into workspace memory
  registerWorkspace(opts.name, opts.path)

  const startRunOpts = buildStartRunOpts(opts, developProjects)
  return { workspace, startRunOpts }
}

// Edit an existing workspace's persisted config in place: rename, adjust stages/models, ADD projects
// (newly-added ones get a worktree) and REMOVE de-selected projects (their worktree is deleted). Path
// is the identity and is not changed.
export async function editWorkspace(args: {
  path: string
  opts: CreateWorkspaceOpts
  knownProjects: Project[]
  proxy: string
  // Same observable-setup event stream as createWorkspace, so adding a project shows live pull
  // progress (git clone/fetch is slow) instead of a silently-hung 保存中 button.
  emit?: (e: SetupEvent) => void
  // When a project is ADDED, optionally re-run the workspace's `__proj` (项目拉取后) hooks against it —
  // the user opts in via a wizard toggle. Requires `providers`; no-op without it.
  runProjHooks?: boolean
  providers?: Record<string, AgentProvider>
  signal?: AbortSignal
}): Promise<Workspace> {
  const path = expandTilde(args.path)
  const { opts, knownProjects, proxy, providers, signal } = args
  const emit = args.emit ?? (() => {})
  const existing = readWorkspace(path)
  if (!existing) throw new Error(`工作区不存在: ${path}`)

  const byId = new Map(knownProjects.map(p => [p.id, p]))
  const projHooks = (opts.stepPlugins ?? []).filter(p => p.after === '__proj')

  // Remove worktrees for projects the user DE-selected (in the old record, absent from opts). This
  // deletes the pulled code on disk — the UI gates it behind a confirmation. The bare mirror and other
  // workspaces' worktrees are untouched. Best-effort: a git failure still falls through to rm the dir.
  const keepIds = new Set(opts.projects.map(p => p.repoId))
  for (const gone of existing.projects.filter(p => !keepIds.has(p.repoId))) {
    const worktreePath = join(path, gone.name)
    await removeWorktree({ mirror: mirrorPath(gone.repoId), worktreePath }).catch(() => {})
    if (existsSync(worktreePath)) { try { rmSync(worktreePath, { recursive: true, force: true }) } catch { /* leave it */ } }
  }

  // Provision only projects whose worktree is genuinely missing on disk — not merely absent from the
  // record. A failed pull writes the project into workspace.json but leaves no worktree; keying the
  // skip on "already in the record" would strand it forever. A worktree's `.git` is a file.
  const toProvision = opts.projects.filter(sel => {
    const proj = byId.get(sel.repoId)
    if (!proj) throw new Error(`未知项目: ${sel.repoId}`)
    return !existsSync(join(path, proj.name, '.git'))
  })
  const willRunHooks = !!args.runProjHooks && !!providers && toProvision.length > 0 && projHooks.length > 0
  if (toProvision.length) emit({ type: 'setup:start', workspacePath: path, hooks: { basic: 0, proj: willRunHooks ? projHooks.length : 0 } })
  let index = 0
  for (const sel of toProvision) {
    const proj = byId.get(sel.repoId)!
    const name = proj.name || sel.repoId
    emit({ type: 'provision:start', project: name, index, total: toProvision.length })
    try {
      await provisionWorktree(proj, sel.branch, path, proxy)
    } catch (e) {
      emit({ type: 'provision:error', project: name, index, total: toProvision.length, message: e instanceof Error ? e.message : String(e) })
      throw e
    }
    emit({ type: 'provision', project: name, index, total: toProvision.length })
    index++
  }

  const workspace: Workspace = {
    name: opts.name,
    path,
    workflowId: '',   // legacy 迁移种子 — 新文件走下面的 workflows
    stages: [],        // legacy 迁移种子
    workflows: opts.workflows.map(wf => ({ id: wf.id, name: wf.name, stages: wf.stages.map(toWsStage) })),
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
  removeWorkspaceSkill(path)   // pure chat (P5 T1): no forge-workflow skill anymore

  // Re-run the `__proj` hooks now that the new project(s) are on disk (user opted in).
  if (willRunHooks) {
    for (const plugin of projHooks) {
      if (signal?.aborted) break
      await runStepHook('__proj', plugin, {
        providers: providers!, stageProvider: opts.workflows[0]?.stages[0]?.provider, stageModel: opts.workflows[0]?.stages[0]?.model,
        proxy, cwd: path, emit, signal,
      })
    }
  }
  if (toProvision.length) emit({ type: 'setup:done', workspacePath: path })
  return workspace
}
