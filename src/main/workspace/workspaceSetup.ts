import { expandTilde } from '../config/paths'
import { writeWorkspace, registerWorkspace } from '../config/store'
import { ensureWorkspaceSkill } from '../skills/installSkill'
import type { Project } from '../config/schema'
import type { Plugin } from '../../shared/plugin'
import type { AgentProvider } from '../agents/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { CreateWorkspaceOpts, SetupEvent } from '@shared/types'
import { runStepHook } from './stepHooks'
import { provisionWorktree, buildWorkspaceRecord, buildStartRunOpts, seedPurposeMemory, type CreateWorkspaceResult } from './workspaceService'

// Re-export SetupEvent from @shared/types for any code that imports it from here.
export type { SetupEvent }

type ProvisionFn = (proj: Project, branch: string, wsPath: string, proxy: string, signal?: AbortSignal) => Promise<string>

export interface RunWorkspaceSetupArgs {
  opts: CreateWorkspaceOpts
  knownProjects: Project[]
  proxy: string
  providers: Record<string, AgentProvider>
  emit: (e: SetupEvent) => void
  // Injectable for testing; defaults to the real git provisioner shared with createWorkspace.
  provision?: ProvisionFn
  // Aborts an in-flight creation (user hit 取消): kills the running git clone/fetch and stops the flow.
  signal?: AbortSignal
}

// Create a workspace as an asynchronous, observable process: write the workspace record EARLY (so it
// exists immediately), then run the `__basic` step plugins → provision worktrees → run the `__proj`
// step plugins, each as a constrained micro-agent via executeHook. Hooks are NON-BLOCKING: an
// erroring (or throwing) hook is marked `err` and the flow continues; provisioned projects are never
// rolled back and setup always ends with setup:done. Returns the same CreateWorkspaceResult shape as
// createWorkspace so callers can treat both paths uniformly.
// Thrown when the user cancels creation mid-flight; the IPC layer treats this as "cancelled" (keep the
// partial on disk, drop the sidebar record) rather than a real error.
export class SetupCancelledError extends Error {
  constructor() { super('创建已取消'); this.name = 'SetupCancelledError' }
}

export async function runWorkspaceSetup(args: RunWorkspaceSetupArgs): Promise<CreateWorkspaceResult> {
  const { knownProjects, proxy, providers, emit, signal } = args
  const provision = args.provision ?? provisionWorktree
  const throwIfCancelled = () => { if (signal?.aborted) throw new SetupCancelledError() }
  // Expand `~` once, up front — same as createWorkspace, so the workspace lives at a real abs path.
  const opts = { ...args.opts, path: expandTilde(args.opts.path) }
  const byId = new Map(knownProjects.map(p => [p.id, p]))
  const stepPlugins = opts.stepPlugins ?? []
  const basicHooks = stepPlugins.filter(p => p.after === '__basic')
  const projHooks = stepPlugins.filter(p => p.after === '__proj')

  // 1. Write the workspace record + skill + registry EARLY so the workspace exists from the start of
  //    the (potentially long) hook/provision process — the UI can navigate to it immediately.
  const workspace = buildWorkspaceRecord(opts, byId)
  writeWorkspace(workspace)
  ensureWorkspaceSkill(opts.path)
  seedPurposeMemory(opts.path, opts.purpose)  // seed 建区目的 into workspace memory
  registerWorkspace(opts.name, opts.path)

  emit({ type: 'setup:start', workspacePath: opts.path, hooks: { basic: basicHooks.length, proj: projHooks.length } })

  const runHook = (phase: '__basic' | '__proj', plugin: Plugin) => runStepHook(phase, plugin, {
    providers, stageProvider: opts.workflows[0]?.stages[0]?.provider, stageModel: opts.workflows[0]?.stages[0]?.model,
    proxy, cwd: opts.path, emit, signal,
  })

  // 2. __basic hooks (after basic info, before any project is pulled). Re-check cancel BEFORE each
  //    hook so a cancel between hooks stops the flow promptly (a cancelled hook returns fast, then the
  //    next throwIfCancelled aborts creation with SetupCancelledError).
  for (const plugin of basicHooks) { throwIfCancelled(); await runHook('__basic', plugin) }

  // 3. Provision worktrees (git). A git failure throws (= workspace creation fails), unchanged by hooks.
  const developProjects: DevelopProject[] = []
  const total = opts.projects.length
  let index = 0
  for (const sel of opts.projects) {
    throwIfCancelled()
    const proj = byId.get(sel.repoId)
    if (!proj) throw new Error(`项目「${sel.repoId}」未注册,无法拉取 —— 请在向导的「项目」步骤重新添加该项目(填写仓库地址)后再创建。`)
    const name = proj.name || sel.repoId
    emit({ type: 'provision:start', project: name, index, total })
    let worktreePath: string
    try {
      worktreePath = await provision(proj, sel.branch, opts.path, proxy, signal)
    } catch (e) {
      // A user cancel surfaces as an execa AbortError → normalize to SetupCancelledError (not a 拉取失败).
      if (signal?.aborted) throw new SetupCancelledError()
      emit({ type: 'provision:error', project: name, index, total, message: e instanceof Error ? e.message : String(e) })
      throw e
    }
    emit({ type: 'provision', project: name, index, total })
    developProjects.push({ name, cwd: worktreePath, provider: sel.provider, model: sel.model })
    index++
  }

  // 4. __proj hooks (after projects are pulled + branched).
  for (const plugin of projHooks) { throwIfCancelled(); await runHook('__proj', plugin) }

  emit({ type: 'setup:done', workspacePath: opts.path })

  const startRunOpts = buildStartRunOpts(opts, developProjects)
  return { workspace, startRunOpts }
}
