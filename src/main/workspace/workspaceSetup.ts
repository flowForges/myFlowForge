import { expandTilde } from '../config/paths'
import { writeWorkspace, registerWorkspace } from '../config/store'
import { ensureWorkspaceSkill } from '../skills/installSkill'
import type { Project } from '../config/schema'
import type { Plugin } from '../../shared/plugin'
import type { LogLine, AgentProvider, AgentCallbacks } from '../agents/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { CreateWorkspaceOpts, SetupEvent } from '@shared/types'
import { executeHook } from '../orchestrator/executeHook'
import { buildPluginPrompt } from '../orchestrator/brief'
import { claudeAllowedTools } from '../agents/pluginTools'
import { buildAgentEnv } from '../agents/env'
import { provisionWorktree, buildWorkspaceRecord, buildStartRunOpts, type CreateWorkspaceResult } from './workspaceService'

// Re-export SetupEvent from @shared/types for any code that imports it from here.
export type { SetupEvent }

type ProvisionFn = (proj: Project, branch: string, wsPath: string, proxy: string) => Promise<string>

export interface RunWorkspaceSetupArgs {
  opts: CreateWorkspaceOpts
  knownProjects: Project[]
  proxy: string
  providers: Record<string, AgentProvider>
  emit: (e: SetupEvent) => void
  // Injectable for testing; defaults to the real git provisioner shared with createWorkspace.
  provision?: ProvisionFn
}

// Create a workspace as an asynchronous, observable process: write the workspace record EARLY (so it
// exists immediately), then run the `__basic` step plugins → provision worktrees → run the `__proj`
// step plugins, each as a constrained micro-agent via executeHook. Hooks are NON-BLOCKING: an
// erroring (or throwing) hook is marked `err` and the flow continues; provisioned projects are never
// rolled back and setup always ends with setup:done. Returns the same CreateWorkspaceResult shape as
// createWorkspace so callers can treat both paths uniformly.
export async function runWorkspaceSetup(args: RunWorkspaceSetupArgs): Promise<CreateWorkspaceResult> {
  const { knownProjects, proxy, providers, emit } = args
  const provision = args.provision ?? provisionWorktree
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
  registerWorkspace(opts.name, opts.path)

  emit({ type: 'setup:start', workspacePath: opts.path, hooks: { basic: basicHooks.length, proj: projHooks.length } })

  // Default provider/model from the first stage (mirrors orchestrator.runHook), proxy-only env (no
  // forge bridge during creation → mcpTools:false text fallback).
  const provider = providers[opts.stages[0]?.provider ?? ''] ?? providers['claude']
  const model = opts.stages[0]?.model ?? ''
  // No forge bridge during creation → buildAgentEnv (proxy only) gives mcpTools:false text fallback,
  // same as __wf hooks run without a bridge.
  const env = buildAgentEnv({ proxy })

  const runHook = async (phase: '__basic' | '__proj', plugin: Plugin) => {
    emit({ type: 'hook:start', phase, plugin: { id: plugin.id, name: plugin.name, skills: plugin.skills, tools: plugin.tools } })
    if (!provider) { emit({ type: 'hook:state', pluginId: plugin.id, state: 'err' }); return }
    const cb: AgentCallbacks = {
      onLog: (line) => emit({ type: 'hook:log', pluginId: plugin.id, line }),
      onState: () => {},
      onConfirm: async () => 'deny',
      onInput: async () => '',
      onDone: () => {},
      onError: () => {},
    }
    const result = await executeHook(
      provider,
      {
        stageKey: 'setup:' + plugin.id,
        agentId: 'setup:' + plugin.id,
        name: plugin.name,
        prompt: buildPluginPrompt(plugin, [], undefined),
        cwd: opts.path,
        model,
        allowedTools: claudeAllowedTools(plugin.tools),
        skills: plugin.skills,
      },
      cb,
      env,
    )
    emit({ type: 'hook:state', pluginId: plugin.id, state: result.ok ? 'ok' : 'err' })
  }

  // 2. __basic hooks (after basic info, before any project is pulled).
  for (const plugin of basicHooks) await runHook('__basic', plugin)

  // 3. Provision worktrees (git). A git failure throws (= workspace creation fails), unchanged by hooks.
  const developProjects: DevelopProject[] = []
  const total = opts.projects.length
  let index = 0
  for (const sel of opts.projects) {
    const proj = byId.get(sel.repoId)
    if (!proj) throw new Error(`未知项目: ${sel.repoId}`)
    const name = proj.name || sel.repoId
    emit({ type: 'provision:start', project: name, index, total })
    let worktreePath: string
    try {
      worktreePath = await provision(proj, sel.branch, opts.path, proxy)
    } catch (e) {
      emit({ type: 'provision:error', project: name, index, total, message: e instanceof Error ? e.message : String(e) })
      throw e
    }
    emit({ type: 'provision', project: name, index, total })
    developProjects.push({ name, cwd: worktreePath, provider: sel.provider, model: sel.model })
    index++
  }

  // 4. __proj hooks (after projects are pulled + branched).
  for (const plugin of projHooks) await runHook('__proj', plugin)

  emit({ type: 'setup:done', workspacePath: opts.path })

  const startRunOpts = buildStartRunOpts(opts, developProjects)
  return { workspace, startRunOpts }
}
