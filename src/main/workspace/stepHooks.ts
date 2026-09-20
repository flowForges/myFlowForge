import type { Plugin } from '../../shared/plugin'
import type { AgentProvider, AgentCallbacks, AgentSession } from '../agents/types'
import type { SetupEvent } from '@shared/types'
import { executeHook } from '../run/executeHook'
import { buildPluginPrompt } from '../run/hookPrompt'
import { claudeAllowedTools } from '../agents/pluginTools'
import { buildAgentEnv } from '../agents/env'
import { nextSetupInteractionId, awaitSetupInteraction, cancelSetupInteraction } from './setupInteractions'
import { gateRegistry } from '../gate/gateRegistry'

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

  /**
   * ★★★权限门走**总线**,不再是这个文件自己的一份抄本。
   *
   *  改之前:onConfirm 只往 `hook:interact` 上发一份,而那张卡只活在建区模态框的 React state 里 ——
   *  用户点一下「后台运行」(overlay 藏起来)或者关掉它,卡就没了,而主进程这边的 Promise
   *  **不超时、不兜底**,于是界面永远停在「运行中 · 1m51s」。而且这道门进不了通知、推送、
   *  机器人桥、宠物气泡里的任何一个 —— 用户在别处根本无从知道有东西在等他。
   *
   *  改之后:门登记在 `gateRegistry` 里(全进程唯一一张表),`hook:interact` 退化成**其中一种呈现**。
   *  id 用总线发的那一个,所以模态框上那张卡答的就是总线里挂着的那道门。
   */
  const gateCtx = {
    origin: 'setup' as const,
    workspacePath: cwd,
    label: `建区 Hook · ${plugin.name}`,
    onRaised: (g: { id: string; title: string; where?: string }) =>
      emit({ type: 'hook:interact', id: g.id, pluginId: plugin.id, kind: 'confirm', title: g.title, where: g.where }),
  }
  const confirm = gateRegistry.confirmFor(gateCtx)
  // 取消建区时把这条工作区上**还挂着的**门一并收掉,否则 hook 会等一道永远不会被回答的门。
  const onAbortGates = () => { gateRegistry.drain((g) => g.origin === 'setup' && g.workspacePath === cwd, 'deny') }
  signal?.addEventListener('abort', onAbortGates)

  const cb: AgentCallbacks = {
    onLog: (line) => emit({ type: 'hook:log', pluginId: plugin.id, line }),
    onState: () => {},
    onConfirm: (req) => confirm(req),
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
        // Setup hooks run with NO forge bridge (env above is proxy-only), so the「MCP 调用」chip would
        // grant `mcp__forge__*` tools that don't exist in this context — a dead, misleading no-op. Drop it
        // here so the grant is honest. (RUN-stage hooks DO get a live bridge, so they keep it.)
        allowedTools: claudeAllowedTools(plugin.tools.filter(t => t !== 'mcp')),
        skills: plugin.skills,
      },
      cb,
      env,
      { onSession: (s) => { session = s; if (signal?.aborted) s.cancel() } },
    )
    emit({ type: 'hook:state', pluginId: plugin.id, state: result.ok ? 'ok' : 'err' })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    signal?.removeEventListener('abort', onAbortGates)
    // ★hook 跑完(成功或失败)时,它自己升起的门一律收掉:进程都没了,那道门再没有人会答,
    //  留着只会让「还有一道门在等」这个提示一直亮着 —— 而那正是这次要修的那种假状态。
    gateRegistry.drain((g) => g.origin === 'setup' && g.workspacePath === cwd, 'deny')
  }
}
