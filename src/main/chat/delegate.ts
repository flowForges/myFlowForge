import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, AgentSession, AgentResult, HandoffPayload } from '../agents/types'
import type { PermissionMode } from '@shared/permissions'
import type { Workspace } from '../config/schema'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'
import { buildAgentEnv } from '../agents/env'
import { startBridge, type BridgeRunCtx } from '../mcp/forgeBridge'
import { STAGE_FORGE_TOOLS } from '../run/runTypes'
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
  permissionMode?: PermissionMode   // 发起会话的权限盾牌(下沉到子代理)
  // 派发前权限门:仅当 runDelegate 判定需要(codex + 写类 + 盾牌未到「完全」)时调用,让用户【本次授权】。
  // 返回 'full'=本次授权完全权限(forge_handoff/forge_ask 才能在 codex 下正常工作);'default'=沿用当前盾牌权限。
  askPermission?: (info: { projects: string[]; write: boolean }) => Promise<'full' | 'default'>
  brief?: string   // 主代理整理的需求简报,注入子代理 prompt(修"委派不带上下文")
  sessionId?: string   // 发起会话 id,用于把委派子代理登记进 IDs 面板(delegateRegistry)
  // A sub-agent's forge_ask → surfaced to the user (chat select/input card); returns the answer.
  ask?: (question: string, options?: { t: string; d: string }[], agentName?: string) => Promise<string | null>
  // Coarse live progress: called with (project name, log text) for tool/file/accent lines during the run.
  onProgress?: (name: string, text: string) => void
  // Called with each spawned sub-agent session — lets the caller register it for cancellation and
  // (P5) surface it in the IDs panel. Optional.
  onSession?: (s: AgentSession) => void
  // 批次派发即触发(全部子代理初始为 'run'):供调用方在对话区渲染一个可折叠的实时进度块,让用户在主代理
  // 这轮结束后仍看得见后台子代理在跑(不必打开 IDs 面板)。runId 用作该进度块的稳定 id。
  onBatchStart?: (runId: string, agents: { agentId: string; name: string; provider: string }[]) => void
  // 单个子代理状态变化时触发('ok'=完成 / 'idle'=失败或超时),更新进度块里对应那一行。完成时带上它的产出
  // (同聚合兜底链:handoff summary → 流式输出 → 最后一条 agent_message),供进度块展开查看「输出」。运行中也会
  // 以 'run' 节流回调(≤2 次/秒),带上正在增长的产出 + 最近一步动作(activity),让用户实时看得见执行过程。
  onAgentState?: (runId: string, agentId: string, status: 'run' | 'ok' | 'idle', output?: string, activity?: string) => void
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

// handoff=false 用于 codex 非完全权限的子代理:它的沙箱(read-only / workspace-write)会把任何 MCP 工具调用当作
// 沙箱逃逸、在 approval_policy=never 下直接取消(codex 原生行为:"user cancelled MCP tool call")。此时既不注入
// forge 工具、也不能教它调 forge_handoff/forge_ask——否则它会白试一轮、最终回答还退化成那句取消错误。改为让它把结论
// 直接写成最后一条完整回答,由聚合端的兜底链(agent_message/流式输出)回传给主代理。
function buildDelegatePrompt(task: string, write: boolean, project: string, handoff: boolean, brief?: string): string {
  const head = (brief ?? '').trim() ? [`【需求简报 — 主代理整理的背景与要求】\n${(brief ?? '').trim()}`] : []
  const report = handoff
    ? [
        '完成后必须调用 forge_handoff 工具,summary 写清你的结论与关键发现(有产物就在 artifacts 里列出路径)。这是你把结果交回主代理的唯一方式。',
        '若中途需要用户确认或补充信息,调用 forge_ask 提问(会冒泡给用户),不要擅自假设。',
      ]
    : [
        '完成后,把你的结论与关键发现直接写成最后一条完整、自足的回答(有产物就在正文里列出其路径)——这段回答就是交回主代理的内容。',
        '注意:本次运行【没有】可用的 forge 工具,不要尝试调用 forge_handoff / forge_ask 等任何 forge_* 工具(调了也会被沙箱取消);需要澄清就在回答里把假设和待确认点写清楚。',
      ]
  return [
    ...head,
    `你是 Forge 委派的子代理,当前工作目录就是项目「${project}」的根目录。请在这里完成下面这件事:`,
    task,
    write
      ? '你可以修改本项目的代码/文件来完成任务。'
      : '这是只读探查:只阅读、检索、分析,不要修改任何文件。',
    ...report,
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
// 每条记录带上发起会话的 sid(未传则记 '' ),这样「停止」能只杀当前会话派发的子代理,不误杀同工作区里另一个
// 并发会话仍在跑的委派(归档/删除等无 sessionId 的调用方继续走「取消全部」)。
interface DelegateEntry { sid: string; s: AgentSession }
const activeDelegates = new Map<string, Set<DelegateEntry>>()
function trackDelegate(wsPath: string, sessionId: string | undefined, s: AgentSession) {
  let set = activeDelegates.get(wsPath)
  if (!set) { set = new Set(); activeDelegates.set(wsPath, set) }
  set.add({ sid: sessionId ?? '', s })
}
function untrackDelegate(wsPath: string, s: AgentSession) {
  const set = activeDelegates.get(wsPath)
  if (!set) return
  for (const entry of set) if (entry.s === s) { set.delete(entry); break }
  if (!set.size) activeDelegates.delete(wsPath)
}
/**
 * 取消某工作区在后台跑的 delegate 子代理(用户点「停止」/关闭工作区/归档/删除时调)。传 sessionId 时只取消该
 * 会话派发的子代理(并发的其它会话不受影响);省略 sessionId 取消该工作区的全部(归档/删除等既有调用方保持不变)。
 * 返回被取消的数量。
 */
export function cancelWorkspaceDelegates(wsPath: string, sessionId?: string): number {
  const set = activeDelegates.get(wsPath)
  if (!set) return 0
  let n = 0
  if (sessionId === undefined) {
    for (const entry of set) { try { entry.s.cancel(); n++ } catch { /* already gone */ } }
    activeDelegates.delete(wsPath)
    return n
  }
  for (const entry of [...set]) {
    if (entry.sid !== sessionId) continue
    try { entry.s.cancel(); n++ } catch { /* already gone */ }
    set.delete(entry)
  }
  if (!set.size) activeDelegates.delete(wsPath)
  return n
}

// 委派子代理空闲看门狗:NO stdout for this long = 认定卡死(codex 常卡在自身 models 刷新/网络读且完全无输出),
// 杀掉该子代理并记失败——避免单个卡住的进程用 Promise.all 拖死整批「汇总回呈」(探查半小时不返回的根因)。与
// orchestrator「静默即卡死」同思路(那里 6min 杀);这里无警告 UI,直接 6min 静默即杀。
export const DELEGATE_IDLE_KILL_MS = 360_000
export const WATCHDOG_TICK_MS = 15_000

export function makeRunDelegate(deps: DelegateDeps) {
  let seq = 0
  return async function runDelegate(opts: DelegateOpts): Promise<DelegateResult> {
    const ws = deps.readWorkspace(opts.workspacePath)
    const all = ws ? workspaceToStartRunOpts(ws).developProjects : []
    // Target 选择:指定了 projects → 每个命中的项目一个子代理(并行);【省略 projects → 单个工作区根代理】
    // (cwd=工作区根,它能看到所有项目子目录/worktree)。原来「省略=铺满所有项目」会把「读一个文件/单一动作」
    // 这类无谓扇出成每项目一个子代理(过度委派:用户让读一个文件却把全工作区都读了)。真要并行铺满多个项目,
    // 显式列出项目名即可。projects 指定但都不匹配(如拼错)时也回退到单根代理(它照样看得到所有项目)。
    const picked = opts.projects?.length ? all.filter(p => opts.projects!.includes(p.name)) : []
    const runId = `delegate-${Date.now()}-${++seq}`
    const targets: Target[] = picked.length
      ? picked.map(p => ({ id: `delegate:${p.name}`, name: p.name, cwd: p.cwd, provider: opts.provider, model: opts.model }))
      : [{ id: 'delegate:workspace', name: 'workspace', cwd: opts.workspacePath, provider: opts.provider, model: opts.model }]

    // Register this batch's sub-agents so the IDs panel surfaces them (delegate has no runId/RunStore).
    if (opts.sessionId) startDelegateBatch(opts.workspacePath, opts.sessionId, targets.map(t => ({ agentId: t.id, name: t.name, provider: t.provider, sessionId: t.id, status: 'run' as const })))
    // 派发即在对话区亮出一个可折叠的实时进度块(全部子代理初始 'run'),让主代理这轮结束后用户仍看得见后台在跑。
    opts.onBatchStart?.(runId, targets.map(t => ({ agentId: t.id, name: t.name, provider: t.provider })))

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
    // agentId → 最后一条 'accent'(agent_message)正文。codex 子代理把最终回答作为 agent_message 发出(非 delta,
    // 无 kind),原来 onLog 只收 'ok'/'output' 级 → codex 即便正常答完、只因 forge_handoff 被沙箱取消,也会退化成空
    // 的「完成」。捞它作兜底,让【只读探查】即使调不了 forge_handoff 也能把结论显示出来(与权限无关)。
    const lastMsg = new Map<string, string>()
    // agentId → 最后活动时间(任何 stdout 字节/日志都刷新)。空闲看门狗据此判定卡死。
    const lastBeat = new Map<string, number>()
    const beat = (id: string) => lastBeat.set(id, Date.now())
    // 子代理产出(同聚合的兜底优先级):handoff summary → 流式输出 → 最后一条 agent_message。用于进度块展开的「输出」。
    const capturedOutput = (id: string): string => (summaries.get(id) ?? outputs.get(id)?.trim() ?? lastMsg.get(id) ?? '').trim()
    // 实时进度回传:onLog 触发很密(每个 delta 一次),按 agentId 节流到 ≤2 次/秒,把「正在增长的产出 + 最近一步
    // 动作」以 status:'run' 推给进度块。activityOf 记录最近一条 tool/file/整段消息,当作「正在做什么」的一行提示。
    const activityOf = new Map<string, string>()
    const lastLiveAt = new Map<string, number>()
    const LIVE_MS = 500
    const emitLive = (id: string, force = false) => {
      const now = Date.now()
      if (!force && now - (lastLiveAt.get(id) ?? 0) < LIVE_MS) return
      lastLiveAt.set(id, now)
      opts.onAgentState?.(runId, id, 'run', capturedOutput(id) || undefined, activityOf.get(id))
    }
    const runOneTarget = (t: Target, permMode: PermissionMode): AgentSession => {
      const provider = deps.providers[t.provider] ?? deps.providers['claude'] ?? Object.values(deps.providers)[0]
      // codex 把「能否调 MCP 工具」与 sandbox_mode 绑死:只有 danger-full-access(permMode 'full')放行,read-only/
      // workspace-write 下 forge_handoff/forge_ask 会被 approval_policy=never 直接取消。所以非完全权限的 codex 子代理
      // 【不注入 forge】(注入了也调不动,只会白试+把最终回答退化成取消错误)。其它 CLI 的 MCP 不绑沙箱,照常注入。
      const forgeUsable = !(t.provider === 'codex' && permMode !== 'full')
      const env = buildAgentEnv({
        proxy: deps.proxy(),
        overrides: (bridge && forgeUsable) ? {
          FORGE_SOCKET: bridge.socketPath,
          FORGE_AGENT_ID: t.id,
          ...(deps.mcpEntry ? { FORGE_MCP_ENTRY: deps.mcpEntry } : {}),
          FORGE_TOOLS: STAGE_FORGE_TOOLS,
        } : undefined,
      })
      const session = provider.run(
        { stageKey: 'delegate', agentId: t.id, name: t.name, prompt: buildDelegatePrompt(opts.task, write, t.name, forgeUsable, opts.brief), cwd: t.cwd, model: t.model, permissionMode: permMode },
        {
          // Capture the sub-agent's answer for the summary fallback. Assistant output STREAMS as many
          // small delta chunks (kind 'output'); they reconstruct the text by CONCATENATION. Joining them
          // with '\n' (the old bug) inserted a hard line break at every delta boundary — mid-word and
          // mid-`**bold**` — which shattered the markdown when rendered (literal `**`, `Vue`→`V\nue`).
          // So: concat deltas faithfully; a complete `level:'ok'` result message supersedes them.
          onLog: (l) => {
            beat(t.id)   // 有日志=活着,刷新空闲看门狗
            if (l.level === 'ok') outputs.set(t.id, l.text.trim())
            else if (l.kind === 'output') outputs.set(t.id, (outputs.get(t.id) ?? '') + l.text)
            // 非 delta 的 'accent' 整段消息(codex 的 agent_message):作为「无 handoff/无 output」时的兜底回传。
            else if (l.level === 'accent' && l.text.trim()) lastMsg.set(t.id, l.text.trim())
            // 「正在做什么」一行提示:最近一条工具/文件动作,或整段(非 delta)消息的首行(≤100 字)。排除 output
            // delta(kind:'output',它是产出正文、已单独流式回传),否则动作行会被答案文本刷屏。
            if ((l.kind === 'tool' || l.kind === 'file' || (l.level === 'accent' && l.kind !== 'output')) && l.text.trim()) {
              activityOf.set(t.id, l.text.trim().split('\n')[0].slice(0, 100))
            }
            if (opts.onProgress && (l.kind === 'tool' || l.kind === 'file')) opts.onProgress(t.name, l.text)
            emitLive(t.id)   // 节流(≤2次/秒)实时回传:产出增长 + 最近一步动作 → 进度块
          },
          // Liveness only:任何 stdout 字节(含无日志行的 lifecycle 事件)都刷新看门狗,避免误杀健康但静默生成的子代理。
          onActivity: () => beat(t.id),
          onState: () => {},
          onSession: (id: string) => { if (opts.sessionId) updateDelegateSession(opts.workspacePath, opts.sessionId, t.id, id) },
          onConfirm: async () => 'deny',
          onInput: async () => '',
          onHandoff: (p: HandoffPayload) => { summaries.set(t.id, p.summary) },
          onDone: () => { if (opts.sessionId) updateDelegateState(opts.workspacePath, opts.sessionId, t.id, 'ok'); opts.onAgentState?.(runId, t.id, 'ok', capturedOutput(t.id)) },
          onError: () => { if (opts.sessionId) updateDelegateState(opts.workspacePath, opts.sessionId, t.id, 'idle'); opts.onAgentState?.(runId, t.id, 'idle', capturedOutput(t.id)) },
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

    // fire-and-forget:【立即】返回「已派发」确认(不阻塞主代理的 forge_delegate MCP 调用,避免撞 codex 对单次 MCP
    // tool call 的 ~180s 上限被取消)。其后的「(按需)派发前权限门 → 同步启动子代理 → 后台聚合 → onComplete 回呈」
    // 全部放进这个后台 IIFE。无权限门时 IIFE 在首个 await(Promise.all)前会同步跑完启动+登记,故 return 时子代理已在跑。
    void (async () => {
      // 权限:读=硬只读(沙箱硬约束,替代仅靠 prompt);写=会话盾牌(缺省 'auto'=工作区可写)。
      let permMode: PermissionMode = write ? (opts.permissionMode ?? 'auto') : 'readonly'
      // 派发前权限门 —— 仅 codex + 写类 + 盾牌未到「完全」时。codex 把「能否调 MCP 工具(forge_handoff/forge_ask)」
      // 与 sandbox_mode 绑死,只有 danger-full-access 放行;写类委派若想正常回传/交互就需要完全权限。弹一次门让用户
      // 【本次授权】(只影响这次运行,不改持久盾牌)。选「仅当前权限」则用盾牌权限,产出靠 agent_message 兜底文本回传。
      // 读类【不弹门】(硬只读 + 兜底已能出结果,弹门纯打扰)。
      if (write && opts.provider === 'codex' && permMode !== 'full' && opts.askPermission) {
        // 注册一个「待授权」伪 session:门未答时用户点「停止」/关闭工作区也能中止等待(否则门会一直挂着、无子代理可杀)。
        let abort: () => void = () => {}
        const gateAborted = new Promise<'aborted'>((res) => { abort = () => res('aborted') })
        const pseudo: AgentSession = { id: `${runId}:gate`, cancel: () => abort(), done: Promise.resolve({ ok: false } as AgentResult) }
        trackDelegate(opts.workspacePath, opts.sessionId, pseudo)
        const choice = await Promise.race([opts.askPermission({ projects: targets.map(t => t.name), write }), gateAborted])
        untrackDelegate(opts.workspacePath, pseudo)
        if (choice === 'aborted') {
          if (opts.sessionId) for (const t of targets) updateDelegateState(opts.workspacePath, opts.sessionId, t.id, 'idle')
          try { await bridge?.close() } catch { /* ignore */ }
          try { rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
          opts.onComplete?.({ text: '已取消:未授权本次委派。', per: [] })
          return
        }
        if (choice === 'full') permMode = 'full'
      }

      // 同步启动所有子代理(provider.run 立即返回在跑的 session)。某个启动即抛错就收尾(cancel 已启动的 + 清理),
      // 经 onComplete 报失败,不留孤儿(盲区2)。
      const running: { t: Target; session: AgentSession }[] = []
      try {
        for (const t of targets) running.push({ t, session: runOneTarget(t, permMode) })
      } catch (err) {
        for (const r of running) { try { r.session.cancel() } catch { /* already gone */ } }
        try { await bridge?.close() } catch { /* ignore */ }
        try { rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
        const msg = `委派启动失败: ${err instanceof Error ? err.message : String(err)}`
        opts.onComplete?.({ text: msg, per: [{ project: 'workspace', summary: msg, ok: false }] })
        return
      }
      // 登记到跨轮存活的取消表(fire-and-forget 后靠它才能在「停止」/关闭工作区时杀掉后台子代理)。
      for (const { session } of running) trackDelegate(opts.workspacePath, opts.sessionId, session)

      // 空闲看门狗:每 tick 检查各子代理最后活动时间,超阈值静默即 cancel(其 done 随即 resolve/reject → Promise.all
      // 不再被单个卡住的子代理拖死)。timedOut 记下被杀者,汇总时标注为超时失败而非普通异常。
      for (const { t } of running) beat(t.id)
      const timedOut = new Set<string>()
      const watchdog = setInterval(() => {
        const now = Date.now()
        for (const { t, session } of running) {
          if (timedOut.has(t.id)) continue
          if (now - (lastBeat.get(t.id) ?? now) > DELEGATE_IDLE_KILL_MS) {
            timedOut.add(t.id)
            try { session.cancel() } catch { /* already gone */ }
          }
        }
      }, WATCHDOG_TICK_MS)
      if (typeof (watchdog as { unref?: () => void }).unref === 'function') (watchdog as { unref: () => void }).unref()

      // 后台等全部完成 → 汇总 → 清理 → onComplete 回呈。onComplete 放 finally,保证无论 Promise.all/bridge.close
      // 抛错,产出都必达、不会静默(盲区1)。
      let per: DelegateResult['per'] = []
      try {
        per = await Promise.all(running.map(async ({ t, session }) => {
          try {
            const r: AgentResult = await session.done
            if (timedOut.has(t.id)) return { project: t.name, summary: '子代理长时间无响应,已超时终止(可能卡在模型刷新/网络读)。', ok: false }
            const summary = summaries.get(t.id) ?? outputs.get(t.id)?.trim() ?? lastMsg.get(t.id) ?? r.summary ?? ''
            return { project: t.name, summary: summary || '(子代理无产出)', ok: r.ok !== false }
          } catch (err) {
            if (timedOut.has(t.id)) return { project: t.name, summary: '子代理长时间无响应,已超时终止(可能卡在模型刷新/网络读)。', ok: false }
            return { project: t.name, summary: `子代理异常: ${err instanceof Error ? err.message : String(err)}`, ok: false }
          }
        }))
      } finally {
        clearInterval(watchdog)
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
