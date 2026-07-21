import type { Plugin } from '../../shared/plugin'
import type { AgentProvider, AgentCallbacks, AgentSession } from '../agents/types'
import type { SetupEvent } from '@shared/types'
import { executeHook } from '../run/executeHook'
import { buildPluginPrompt } from '../run/hookPrompt'
import { claudeAllowedTools } from '../agents/pluginTools'
import { buildAgentEnv } from '../agents/env'
import { nextSetupInteractionId, awaitSetupInteraction, cancelSetupInteraction } from './setupInteractions'

export interface StepHookCtx {
  providers: Record<string, AgentProvider>
  // Default provider/model come from the first workflow stage (mirrors orchestrator.runHook).
  stageProvider?: string
  stageModel?: string
  proxy: string
  cwd: string
  emit: (e: SetupEvent) => void
  signal?: AbortSignal
}

// Run ONE step plugin (a `__basic`/`__proj` hook) as a constrained micro-agent, streaming hook:start /
// hook:log / hook:state events. Shared by createWorkspace's runWorkspaceSetup and editWorkspace so both
// paths execute hooks identically — including 取消 wiring (the abort signal cancels the subprocess).
export async function runStepHook(phase: '__basic' | '__proj', plugin: Plugin, ctx: StepHookCtx): Promise<void> {
  const { providers, proxy, cwd, emit, signal } = ctx
  const provider = providers[ctx.stageProvider ?? ''] ?? providers['claude']
  const model = ctx.stageModel ?? ''
  // No forge bridge here → buildAgentEnv (proxy only) gives the mcpTools:false text fallback.
  const env = buildAgentEnv({ proxy })

  emit({ type: 'hook:start', phase, plugin: { id: plugin.id, name: plugin.name, skills: plugin.skills, tools: plugin.tools } })
  if (!provider) { emit({ type: 'hook:state', pluginId: plugin.id, state: 'err' }); return }

  // Bubble a hook's permission-confirm / input request to the UI (SetupProgress) and await the user's
  // answer, instead of silently denying it. Emits `hook:interact`, blocks on the resolver map, and
  // auto-resolves to deny/'' if the setup is cancelled so a hook never hangs on abort.
  const raise = (kind: 'confirm' | 'input', title: string, where?: string, placeholder?: string): Promise<{ decision?: 'allow' | 'deny'; value?: string }> => {
    const id = nextSetupInteractionId(plugin.id)
    const answer = awaitSetupInteraction(id)
    emit({ type: 'hook:interact', id, pluginId: plugin.id, kind, title, where, placeholder })
    const onAbortRaise = () => cancelSetupInteraction(id, kind === 'confirm' ? { decision: 'deny' } : { value: '' })
    signal?.addEventListener('abort', onAbortRaise, { once: true })
    return answer.finally(() => signal?.removeEventListener('abort', onAbortRaise))
  }
  const cb: AgentCallbacks = {
    onLog: (line) => emit({ type: 'hook:log', pluginId: plugin.id, line }),
    onState: () => {},
    onConfirm: async (req) => (await raise('confirm', req.title, req.where)).decision ?? 'deny',
    onInput: async (req) => (await raise('input', req.title, undefined, req.placeholder)).value ?? '',
    onDone: () => {},
    onError: () => {},
  }
  // Wire 取消 through to the hook subprocess: a hook can run a long, silent command (install/build), so
  // without this it kept running after the user cancelled. Capture the session and cancel() on abort.
  let session: AgentSession | undefined
  const onAbort = () => { try { session?.cancel() } catch { /* already gone */ } }
  signal?.addEventListener('abort', onAbort)
  try {
    const result = await executeHook(
      provider,
      {
        stageKey: 'setup:' + plugin.id,
        agentId: 'setup:' + plugin.id,
        name: plugin.name,
        prompt: buildPluginPrompt(plugin, [], undefined),
        cwd,
        model,
        allowedTools: claudeAllowedTools(plugin.tools),
        skills: plugin.skills,
      },
      cb,
      env,
      { onSession: (s) => { session = s; if (signal?.aborted) s.cancel() } },
    )
    emit({ type: 'hook:state', pluginId: plugin.id, state: result.ok ? 'ok' : 'err' })
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
