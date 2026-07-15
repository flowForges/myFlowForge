import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, AgentSession, AgentResult, HandoffPayload } from '../agents/types'
import type { Workspace } from '../config/schema'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'
import { buildAgentEnv } from '../agents/env'
import { startBridge, type BridgeRunCtx } from '../mcp/forgeBridge'
import { STAGE_FORGE_TOOLS } from '../orchestrator/orchestrator'
import { startDelegateBatch, updateDelegateSession, updateDelegateState, addDelegateAgent } from './delegateRegistry'

// Lightweight delegation (path A of the dual-path design): the main chat agent dispatches sub-agents
// straight into project directories to read/write code and hands their results back — WITHOUT the
// workflow gate or the orchestrator's single-run state machine. Sub-agents get STAGE_FORGE_TOOLS
// (handoff/ask/…, no propose/delegate → no recursion), cd into each project (loading its skills/rules),
// and report via forge_handoff. Runs are ephemeral: a throwaway tmp dir hosts the bridge socket and a
// stub store; nothing is persisted to the workspace.

export interface DelegateDeps {
  providers: Record<string, AgentProvider>
  proxy: () => string
  mcpEntry: string | undefined
  readWorkspace: (p: string) => Workspace | null
}

export interface DelegateOpts {
  workspacePath: string
  task: string
  projects?: string[]
  write?: boolean
  provider: string
  model: string
  permissionMode?: import('@shared/permissions').PermissionMode   // 发起会话的权限盾牌(下沉到子代理)
  brief?: string   // 主代理整理的需求简报,注入子代理 prompt(修"委派不带上下文")
  sessionId?: string   // 发起会话 id,用于把委派子代理登记进 IDs 面板(delegateRegistry)
  // A sub-agent's forge_ask → surfaced to the user (chat select/input card); returns the answer.
  ask?: (question: string, options?: { t: string; d: string }[], agentName?: string) => Promise<string | null>
  // Coarse live progress: called with (project name, log text) for tool/file/accent lines during the run.
  onProgress?: (name: string, text: string) => void
  // Called with each spawned sub-agent session — lets the caller register it for cancellation and
  // (P5) surface it in the IDs panel. Optional.
  onSession?: (s: AgentSession) => void
  // Fire-and-forget 完成回调:所有子代理跑完后调用一次,带聚合结果。runDelegate 会【立即】返回一个「已派发」
  // 确认(这样主代理的 forge_delegate MCP 调用不会挂到 codex 的 ~180s tool 超时被取消);真实聚合产出经此回调
  // 交回给调用方,由调用方呈现回会话(append 一条新消息)。
  onComplete?: (r: DelegateResult) => void
}

export interface DelegateResult {
  text: string
  per: { project: string; summary: string; ok: boolean }[]
}

interface Target { id: string; name: string; cwd: string; provider: string; model: string }

function buildDelegatePrompt(task: string, write: boolean, project: string, brief?: string): string {
  const head = (brief ?? '').trim() ? [`【需求简报 — 主代理整理的背景与要求】\n${(brief ?? '').trim()}`] : []
  return [
    ...head,
    `你是 Forge 委派的子代理,当前工作目录就是项目「${project}」的根目录。请在这里完成下面这件事:`,
    task,
    write
      ? '你可以修改本项目的代码/文件来完成任务。'
      : '这是只读探查:只阅读、检索、分析,不要修改任何文件。',
    '完成后必须调用 forge_handoff 工具,summary 写清你的结论与关键发现(有产物就在 artifacts 里列出路径)。这是你把结果交回主代理的唯一方式。',
    '若中途需要用户确认或补充信息,调用 forge_ask 提问(会冒泡给用户),不要擅自假设。',
  ].join('\n\n')
}

// Minimal store satisfying the bridge's ctx.store shape. Delegate runs are ephemeral, so context
// reads return nothing and artifact writes are no-ops (path echoed back).
const stubStore = {
  getContext: () => undefined,
  writeArtifact: (name: string) => ({ path: name }),
  appendMessage: () => {},
} as unknown as BridgeRunCtx['store']

// workspace → 该工作区当前在【后台】跑的 delegate 子代理 session 集合。fire-and-forget 后子代理脱离了 chat
// 轮次(轮末 chatQueue.activeCancel 被置 null),没有这张跨轮存活的表,用户点「停止」或关闭工作区时就杀不掉后台
// 子代理,会留成孤儿进程。启动时 track,后台完成/失败时 untrack;取消时遍历 cancel。
const activeDelegates = new Map<string, Set<AgentSession>>()
function trackDelegate(wsPath: string, s: AgentSession) {
  let set = activeDelegates.get(wsPath)
  if (!set) { set = new Set(); activeDelegates.set(wsPath, set) }
  set.add(s)
}
function untrackDelegate(wsPath: string, s: AgentSession) {
  const set = activeDelegates.get(wsPath)
  if (!set) return
  set.delete(s)
  if (!set.size) activeDelegates.delete(wsPath)
}
/** 取消某工作区所有在后台跑的 delegate 子代理(用户点「停止」/关闭工作区时调)。返回被取消的数量。 */
export function cancelWorkspaceDelegates(wsPath: string): number {
  const set = activeDelegates.get(wsPath)
  if (!set) return 0
  let n = 0
  for (const s of set) { try { s.cancel(); n++ } catch { /* already gone */ } }
  activeDelegates.delete(wsPath)
  return n
}

export function makeRunDelegate(deps: DelegateDeps) {
  let seq = 0
  return async function runDelegate(opts: DelegateOpts): Promise<DelegateResult> {
    const ws = deps.readWorkspace(opts.workspacePath)
    const all = ws ? workspaceToStartRunOpts(ws).developProjects : []
    // Target projects: filter by name; empty/no-match → all; no projects at all → one root agent.
    let picked = all
    if (opts.projects?.length) {
      const want = new Set(opts.projects)
      const f = all.filter(p => want.has(p.name))
      if (f.length) picked = f
    }
    const runId = `delegate-${Date.now()}-${++seq}`
    const targets: Target[] = picked.length
      ? picked.map(p => ({ id: `delegate:${p.name}`, name: p.name, cwd: p.cwd, provider: opts.provider, model: opts.model }))
      : [{ id: 'delegate:workspace', name: 'workspace', cwd: opts.workspacePath, provider: opts.provider, model: opts.model }]

    // Register this batch's sub-agents so the IDs panel surfaces them (delegate has no runId/RunStore).
    if (opts.sessionId) startDelegateBatch(opts.workspacePath, opts.sessionId, targets.map(t => ({ agentId: t.id, name: t.name, provider: t.provider, sessionId: t.id, status: 'run' as const })))

    // agentId → captured handoff summary (MCP-native via ctx.setContext, or text-fence via onHandoff).
    const summaries = new Map<string, string>()
    // agentId → accumulated log output, used as a fallback summary when no handoff arrives.
    const outputs = new Map<string, string>()

    const runDir = mkdtempSync(join(tmpdir(), 'forge-delegate-'))
    const bridge = await startBridge(runDir, {
      store: stubStore,
      runId,
      workspaceName: opts.workspacePath,
      agentName: (id) => targets.find(t => t.id === id)?.name ?? id,
      agentStage: () => 'delegate',
      ask: async (agentId, question, options) => opts.ask ? opts.ask(question, options, targets.find(t => t.id === agentId)?.name) : null,
      setContext: (key, value) => {
        if (key.startsWith('handoff:') && typeof value === 'string') summaries.set(key.slice('handoff:'.length), value)
      },
    }).catch(() => null)

    const write = opts.write === true
    const runOneTarget = (t: Target): AgentSession => {
      const provider = deps.providers[t.provider] ?? deps.providers['claude'] ?? Object.values(deps.providers)[0]
      const env = buildAgentEnv({
        proxy: deps.proxy(),
        overrides: bridge ? {
          FORGE_SOCKET: bridge.socketPath,
          FORGE_AGENT_ID: t.id,
          ...(deps.mcpEntry ? { FORGE_MCP_ENTRY: deps.mcpEntry } : {}),
          FORGE_TOOLS: STAGE_FORGE_TOOLS,
        } : undefined,
      })
      const session = provider.run(
        // write=false 时强制 readonly(sandbox 硬约束,替代仅靠 prompt 的软约束);write=true 时用会话盾牌
        // (盾牌为 readonly 则仍只读,盾牌是上限)。缺省盾牌 → 'auto'(工作区可写),即历史行为。
        { stageKey: 'delegate', agentId: t.id, name: t.name, prompt: buildDelegatePrompt(opts.task, write, t.name, opts.brief), cwd: t.cwd, model: t.model, permissionMode: write ? (opts.permissionMode ?? 'auto') : 'readonly' },
        {
          // Capture the sub-agent's answer for the summary fallback. Assistant output STREAMS as many
          // small delta chunks (kind 'output'); they reconstruct the text by CONCATENATION. Joining them
          // with '\n' (the old bug) inserted a hard line break at every delta boundary — mid-word and
          // mid-`**bold**` — which shattered the markdown when rendered (literal `**`, `Vue`→`V\nue`).
          // So: concat deltas faithfully; a complete `level:'ok'` result message supersedes them.
          onLog: (l) => {
            if (l.level === 'ok') outputs.set(t.id, l.text.trim())
            else if (l.kind === 'output') outputs.set(t.id, (outputs.get(t.id) ?? '') + l.text)
            if (opts.onProgress && (l.kind === 'tool' || l.kind === 'file')) opts.onProgress(t.name, l.text)
          },
          onState: () => {},
          onSession: (id: string) => { if (opts.sessionId) updateDelegateSession(opts.workspacePath, opts.sessionId, t.id, id) },
          onConfirm: async () => 'deny',
          onInput: async () => '',
          onHandoff: (p: HandoffPayload) => { summaries.set(t.id, p.summary) },
          onDone: () => { if (opts.sessionId) updateDelegateState(opts.workspacePath, opts.sessionId, t.id, 'ok') },
          onError: () => { if (opts.sessionId) updateDelegateState(opts.workspacePath, opts.sessionId, t.id, 'idle') },
          // Grand-agent (best-effort): a sub-agent's own built-in Task → depth-2 row under this sub-agent.
          onSubagent: (ev) => {
            if (!opts.sessionId) return
            const gid = `${t.id}/${ev.id}`
            if (ev.phase === 'start') addDelegateAgent(opts.workspacePath, opts.sessionId, { agentId: gid, name: ev.description || ev.subagentType || '内部子任务', provider: t.provider, sessionId: ev.id, status: 'run', depth: 2, parentId: t.id })
            else updateDelegateState(opts.workspacePath, opts.sessionId, gid, 'ok')
          },
        },
        env,
      )
      opts.onSession?.(session)
      return session
    }

    // 先【同步启动】所有子代理(provider.run 立即返回一个正在跑的 session),但【不阻塞等它们跑完】—— 阻塞会
    // 让主代理的 forge_delegate MCP 调用一直挂着,撞上 codex 对单次 MCP tool call 的 ~180s 上限被取消(核心
    // bug 根因)。用循环+收集:某个 target 同步启动就抛错时,把已启动的收尾(cancel+清理),经 onComplete 报失败,
    // 不留孤儿、也不让 runDelegate 直接 throw 导致「已派发」不返回、产出静默(盲区2)。
    const running: { t: Target; session: AgentSession }[] = []
    try {
      for (const t of targets) running.push({ t, session: runOneTarget(t) })
    } catch (err) {
      for (const r of running) { try { r.session.cancel() } catch { /* already gone */ } }
      try { await bridge?.close() } catch { /* ignore */ }
      try { rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      const msg = `委派启动失败: ${err instanceof Error ? err.message : String(err)}`
      opts.onComplete?.({ text: msg, per: [{ project: 'workspace', summary: msg, ok: false }] })
      return { text: msg, per: [] }
    }

    // 登记到跨轮存活的取消表(fire-and-forget 后靠它才能在「停止」/关闭工作区时杀掉后台子代理)。
    for (const { session } of running) trackDelegate(opts.workspacePath, session)

    // 后台等全部完成 → 汇总 → 清理 → onComplete 回呈。子代理跑在本函数自建的独立 bridge(不是主代理轮次的主
    // bridge),所以主代理这一轮结束、finally 里 close 主 bridge,并不会打断这些子代理。onComplete 放在 finally,
    // 保证【无论 Promise.all 还是 bridge.close 抛错,产出都必达】,不会静默(盲区1)。
    void (async () => {
      let per: DelegateResult['per'] = []
      try {
        per = await Promise.all(running.map(async ({ t, session }) => {
          try {
            const r: AgentResult = await session.done
            const summary = summaries.get(t.id) ?? outputs.get(t.id)?.trim() ?? r.summary ?? ''
            return { project: t.name, summary: summary || '(子代理无产出)', ok: r.ok !== false }
          } catch (err) {
            return { project: t.name, summary: `子代理异常: ${err instanceof Error ? err.message : String(err)}`, ok: false }
          }
        }))
      } finally {
        for (const { session } of running) untrackDelegate(opts.workspacePath, session)
        try { await bridge?.close() } catch { /* ignore */ }
        try { rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
        const text = per.length
          ? per.map(p => `### ${p.project}${p.ok ? '' : ' (失败)'}\n${p.summary}`).join('\n\n')
          : '(委派未产生结果)'
        opts.onComplete?.({ text, per })
      }
    })()

    // 立即把「已派发」确认返回给主代理(不等真实产出——产出稍后经 onComplete 呈现)。
    const names = targets.map(t => t.name).join('、')
    return {
      text: `已在后台派发 ${targets.length} 个 Forge 子代理(${names})执行本次委派,它们各自 cd 进项目独立跑,进度见右侧检查器 / IDs 面板。全部完成后,汇总结果会自动作为一条新消息出现在本会话。请你现在只简短告诉用户「已派发子代理在后台执行,完成后会把汇总自动带回来」,不要臆造产出、也不要干等。`,
      per: [],
    }
  }
}
