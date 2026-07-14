import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, AgentSession, AgentResult, HandoffPayload } from '../agents/types'
import type { Workspace } from '../config/schema'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'
import { buildAgentEnv } from '../agents/env'
import { startBridge, type BridgeRunCtx } from '../mcp/forgeBridge'
import { STAGE_FORGE_TOOLS } from '../orchestrator/orchestrator'

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
  // Called with each spawned sub-agent session — lets the caller register it for cancellation and
  // (P5) surface it in the IDs panel. Optional.
  onSession?: (s: AgentSession) => void
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
      ask: async () => null,   // P1: no ask UI wired for delegate; sub-agent forge_ask resolves to null
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
          onLog: (l) => { if (l.level === 'ok' || l.kind === 'output') outputs.set(t.id, (outputs.get(t.id) ? outputs.get(t.id) + '\n' : '') + l.text) },
          onState: () => {},
          onConfirm: async () => 'deny',
          onInput: async () => '',
          onHandoff: (p: HandoffPayload) => { summaries.set(t.id, p.summary) },
          onDone: () => {},
          onError: () => {},
        },
        env,
      )
      opts.onSession?.(session)
      return session
    }

    const per = await Promise.all(targets.map(async (t) => {
      try {
        const session = runOneTarget(t)
        const r: AgentResult = await session.done
        const summary = summaries.get(t.id) ?? outputs.get(t.id)?.trim() ?? r.summary ?? ''
        return { project: t.name, summary: summary || '(子代理无产出)', ok: r.ok !== false }
      } catch (err) {
        return { project: t.name, summary: `子代理异常: ${err instanceof Error ? err.message : String(err)}`, ok: false }
      }
    }))

    await bridge?.close()
    try { rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }

    const text = per.map(p => `### ${p.project}${p.ok ? '' : ' (失败)'}\n${p.summary}`).join('\n\n')
    return { text, per }
  }
}
