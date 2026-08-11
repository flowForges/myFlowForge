import { existsSync } from 'node:fs'
import { appendMessage, readMessages, readSession, readWatermark, writeSession, writeWatermark } from './chatStore'
import { setLive, clearLive } from './liveTurns'
import { setNativeSubagents } from './nativeSubagentRegistry'
import type { AgentProvider, AgentSession, ConfirmReq, ConfirmDecision } from '../agents/types'
import type { ChatSendPayload, ChatMessage, ChatEvent, SubagentCard, ToolActivity } from '@shared/types'
import { buildMemoryPreamble } from './memory/preamble'
import { inlineHtmlPreamble } from './inlineHtmlDirective'
import { buildContinuationPreamble, buildLocalHistoryPreamble } from './continuation'
import { distillSession, promoteToWorkspace, promoteToSystem, type DistillDeps } from './memory/distiller'
import { distillModelFor } from './memory/distillModel'
import { removeNativeSession } from '../agents/nativeSessionCleanup'
import { paceAssistantDeltas } from '../agents/paceDeltas'
import { estimateMessagesTokens, SESSION_DISTILL_THRESHOLD, SYSTEM_PROMOTE_EVERY_K, WORKSPACE_PROMOTE_EVERY_K } from './memory/tokenEstimate'
import { estimateTokens as estimateContextTokens } from '@shared/estimateTokens'
import { readSettings } from '../config/store'
import { discoverAgentContext, extractRuntimeContext, forgeMcpContext, mergeAgentContext, mentionedSkills } from '../agents/contextMeta'
import { scanGlobalContext } from '../agents/globalContext'
import { homedir } from 'node:os'
import { readInstalledSkills } from '../skills/installedSkills'
import { getSession, setSessionMemPromoted, setSessionWorkflow, autoNameIfDefault } from './sessionStore'
import { providerSupportsResume, providerResumeReliable } from '../agents/resumeSupport'
import { logDebug } from '../log/appLog'
import { perfSpan } from '../perf/perfSpans'
import { addDailyTokens } from '../tokens/growthSignalRef'

export interface SendTurnDeps {
  provider: AgentProvider
  env: NodeJS.ProcessEnv
  emit: (e: ChatEvent) => void
  confirm?: (req: ConfirmReq) => Promise<ConfirmDecision>
  onSessionStart?: (session: AgentSession) => void
}

let seq = 0
function mkId(prefix: string) { return `${prefix}-${Date.now()}-${++seq}` }
// Full ISO timestamp (UTC instant) — the renderer formats it to LOCAL time + date. (Older builds stored a
// UTC clock-only "HH:MM:SS", which showed the wrong timezone and carried no date; this fixes both.)
function now() { return new Date().toISOString() }

export function history(wsPath: string, sessionId: string): ChatMessage[] { return readMessages(wsPath, sessionId) }

// Installed skills (incl. home/plugin, e.g. superpowers) cached for the session — used to flag skills
// the agent names in its reply. Skills change rarely, so a one-time scan is fine.
let _skillsCache: { name: string; path: string }[] | null = null
function cachedInstalledSkills(): { name: string; path: string }[] {
  if (!_skillsCache) _skillsCache = readInstalledSkills(undefined, true).map(s => ({ name: s.name, path: s.path }))
  return _skillsCache
}

export function sendTurn(payload: ChatSendPayload, deps: SendTurnDeps): Promise<ChatMessage> {
  return perfSpan('chat', 'sendTurn', () => {
    const { provider, env, emit } = deps
    const ws = payload.workspacePath
    const sid = payload.sessionId
    // Memory master switch. Off = non-destructive pause: no preamble injection (read) and no distillation
    // (write); the on-disk memory files are untouched. Default true (see MemorySchema).
    const memoryOn = readSettings().memory.enabled
    // 内嵌 HTML 可视化(设置 → 外观):打开后每轮前置一段格式指令,鼓励模型用内嵌 HTML 片段表达对比矩阵/
    // 流程结构/信息卡片。渲染端的白名单才是安全边界,这段只是「请求」。
    const inlineHtmlOn = readSettings().appearance.chatInlineHtml === true
    const label = `${payload.agentLabel} · ${payload.model}`
    // "已加载 SKILL / RULE / MCP" card source. Provider-aware now (payload.agent): the project scan +
    // the real home-level rules/MCP (scanGlobalContext, previously never wired into chat) are both
    // filtered to what THIS CLI actually reads, so a Codex session stops listing CLAUDE.md/.claude
    // skills it never loads. forge MCP is real for every provider (injected via env). Runtime scrapes
    // (extractRuntimeContext / mentionedSkills, below) still add anything the model actually prints.
    let context = mergeAgentContext(
      mergeAgentContext(discoverAgentContext(ws, ws, payload.agent), scanGlobalContext(homedir(), payload.agent, false)),
      forgeMcpContext(env),
    )

    // 原生续聊：续自导入会话、同源同代理、该 provider 真的传 --resume、还没拿到新 resumeId、原 cwd 仍在
    // → 用原会话 id 让 CLI 原生 resume（完整上下文），跳过文本摘要 preamble。
    const meta = getSession(ws, sid)
    const cont = meta?.continuedFrom
    const nativeResumeId = (cont
      && payload.agent === cont.source
      && providerSupportsResume(payload.agent)
      && readSession(ws, sid, payload.agent) === undefined
      && existsSync(ws))
      ? cont.externalId
      : undefined

    // Three-branch context-continuity selection for the ACTIVE provider (payload.agent) in this session:
    //   1. No native session yet for this provider (first turn with it, or a non-chat `run()` provider,
    //      which never gets a native session) → full local history preamble.
    //   2. Has a native session, but its watermark is behind the session's latest message count (the
    //      user switched away and back while another provider ran turns in between) → INCREMENTAL
    //      preamble covering only what it missed; it still resumes its own native session for its own
    //      continuity, this just bridges the gap left by other providers.
    //   3. Has a native session and is caught up → no preamble (fast path, unchanged).
    // `latest` must be read BEFORE this turn's user message is appended below, so it reflects prior
    // conversation history only (not double-counting the message we're about to add).
    const hasSession = provider.chat ? readSession(ws, sid, payload.agent) !== undefined : false
    const watermark = readWatermark(ws, sid, payload.agent)
    const latest = readMessages(ws, sid).length
    // Can we TRUST this provider's native resume to redeliver the prior transcript this turn? Only when
    // it has a native session AND that provider's resume is reliable (claude). codex/cursor/qoder/
    // opencode can silently start a fresh thread, so their resume is never trusted — we re-feed history.
    const resumeTrusted = hasSession && providerResumeReliable(payload.agent)
    // "gapped" (→ inject the rolling session summary) whenever native resume can't be trusted to carry
    // history: a gapped resume id, no native session yet, OR an unreliable-resume provider.
    const gapped = nativeResumeId ? false : !resumeTrusted
    const preamble = memoryOn ? buildMemoryPreamble(ws, sid, { resumeGapped: gapped }) : ''
    // Imported sessions re-feed the external transcript; in-app sessions (provider switch, e.g.
    // qoder→codex) fall back to Forge's own stored messages so the new CLI keeps prior context.
    let contPre = ''
    if (nativeResumeId) {
      contPre = buildContinuationPreamble(ws, sid)
    } else if (!hasSession) {
      contPre = buildLocalHistoryPreamble(ws, sid)
    } else if (watermark < latest) {
      contPre = buildLocalHistoryPreamble(ws, sid, {}, { fromIndex: watermark })
    } else if (!resumeTrusted) {
      // Fast path (native session caught up) would inject nothing — but an unreliable-resume provider
      // may silently redeliver NONE of it, leaving the agent with only this turn's text (the "主代理只
      // 按标题作答/丢历史" bug). Re-feed the clamped local history as a safety net.
      contPre = buildLocalHistoryPreamble(ws, sid)
    }
    // 对话式工作流:进入某个对话阶段后的第一轮,一次性注入该阶段的"角色提示"(preamble),告诉 agent
    // 现在在做哪一步、直到用户点"下一步"才换阶段。注入到 promptText 而非 payload.text,保持存档干净;
    // 用 preambleDoneIndex 记账,保证每阶段只注入一次(不每轮重复)。
    let stagePre = ''
    const wfs = meta?.workflowSession
    if (wfs && wfs.phase === 'chatting') {
      const stage = wfs.stages[wfs.currentIndex]
      if (stage && wfs.currentIndex !== wfs.preambleDoneIndex) {
        stagePre = `【工作流「${wfs.flowName}」· 第 ${wfs.currentIndex + 1}/${wfs.stages.length} 步:${stage.name}】\n${stage.preamble ?? ''}\n（本阶段内你都在与用户就这一步对话、按需迭代；用户点「下一步」才进入下一阶段，届时会另行告知。）`
        setSessionWorkflow(ws, sid, { ...wfs, preambleDoneIndex: wfs.currentIndex })
      }
    }
    // 格式指令排在最前:它是「怎么写」的全局约束,后面的阶段角色/历史/记忆都是「写什么」的内容。
    const promptText = [inlineHtmlPreamble(inlineHtmlOn), stagePre, contPre, preamble, payload.text].filter(Boolean).join('\n')

    const userMsg: ChatMessage = {
      id: mkId('u'), who: 'user', text: payload.text,
      files: payload.attachments.length ? payload.attachments : undefined, ts: now()
    }
    appendMessage(ws, sid, userMsg)
    // 会话自动命名:普通聊天用首条用户消息命名(仍是 '新会话' 才改,导入会话有真实标题不受影响)。工作流
    // 会话不在这里命名——它在 workflow:enter 用 seed(原始需求)命名,避免被 "请开始「…」" 这类 kick 消息覆盖。
    if (!wfs && payload.text?.trim()) autoNameIfDefault(ws, sid, payload.text)
    emit({ workspacePath: ws, sessionId: sid, type: 'user', message: userMsg })

    const aid = mkId('a')
    // Whole-turn start (≈ LLM begins). Stamped main-side so it survives into the live mirror + persisted
    // message — the renderer also captures it on assistant-start, but that's lost when the chat view
    // mounts mid-turn / the turn was started from the pet / on reload, which hid the 用时 total (the
    // "计时器没了" bug). endedAt is stamped on finish below.
    const startedAt = Date.now()
    emit({ workspacePath: ws, sessionId: sid, type: 'assistant-start', id: aid, model: label, context })
    let text = ''
    let think = ''
    let lastUsage: { used: number; window: number } | undefined
    // 本轮累计 token 成本(input+output),用于用量汇总账本。一个 turn 里可能有多段 result 用量,累加之。
    let turnTokens: { input: number; output: number } | undefined
    // Built-in Task sub-agents spawned this turn, keyed by tool_use id — accumulated live and persisted
    // on the finished message so their cards survive reload.
    const subagents = new Map<string, SubagentCard>()
    const subagentList = () => (subagents.size ? [...subagents.values()] : undefined)
    // The main agent's OWN tool calls this turn (the "执行" block) — accumulated live (title on start,
    // output/status on done) keyed by tool_use id, persisted on the finished message so the execution
    // trace survives reload. Insertion order = execution order (Map preserves it).
    const tools = new Map<string, ToolActivity>()
    const toolList = () => (tools.size ? [...tools.values()] : undefined)
    // Reset the IDs-panel view of this session's native Task sub-agents at turn start, then keep it in
    // sync as they arrive (see onSubagent) so the panel reflects the current turn, not a stale prior one.
    setNativeSubagents(ws, sid, [])
    const syncNativeSubagents = () => setNativeSubagents(ws, sid, [...subagents.values()].map(c => ({
      id: c.id,
      name: c.description || c.subagentType || '子代理',
      provider: payload.agent,
      status: c.state === 'running' ? 'run' as const : c.state === 'error' ? 'idle' as const : 'ok' as const,
    })))
    // When the main agent turn ends by ANY path, its native Task sub-agents have necessarily ended too
    // (the parent stream can't finish while a Task tool_use is still pending). If a sub-agent's terminal
    // event was lost — or cancel killed the process before it arrived — the card would stay '运行中'
    // forever. Finalize every still-running sub-agent / tool here so persisted history reflects reality.
    // `done` on success (assume it completed), `error` on cancel/error.
    const finalizeRunning = (outcome: 'done' | 'error') => {
      let changed = false
      for (const [id, c] of subagents) if (c.state === 'running') { subagents.set(id, { ...c, state: outcome, result: outcome === 'error' ? (c.result ?? '已取消') : c.result }); changed = true }
      for (const [id, t] of tools) if (t.status === 'run') { tools.set(id, { ...t, status: outcome === 'done' ? 'ok' : 'error' }); changed = true }
      if (changed) syncNativeSubagents()
    }
    // Mirror the in-flight message into the live buffer so chatHistory can restore it after the chat view
    // unmounts (switch to home) or re-subscribes to another session mid-stream. ts:'' marks it as still
    // streaming (carry-forward ordering in the timeline; also lets the renderer re-flag streamingIds).
    const publishLive = () => setLive(ws, sid, {
      id: aid, who: 'ai', text, model: label, provider: payload.agent, ts: '', startedAt,
      think: { label: '主代理思考中…', steps: think ? think.split('\n').map(s => s.trim()).filter(Boolean) : [] },
      context, usage: lastUsage, subagents: subagentList(), tools: toolList(),
    })
    // Main-agent tool call → the 执行 block. 'start' registers the row (title); 'done' fills output/status.
    const onToolActivity = (ev: { id: string; phase: 'start' | 'done'; name?: string; title?: string; output?: string; isError?: boolean }) => {
      const prev = tools.get(ev.id) ?? { id: ev.id, title: ev.title ?? ev.name ?? '调用工具', status: 'run' as const }
      const next: ToolActivity = {
        ...prev,
        title: ev.title ?? prev.title,
        name: ev.name ?? prev.name,
        output: ev.output ?? prev.output,
        status: ev.phase === 'done' ? (ev.isError ? 'error' : 'ok') : prev.status,
      }
      tools.set(ev.id, next)
      publishLive()
      emit({ workspacePath: ws, sessionId: sid, type: 'tool-activity', id: aid, tool: next })
    }
    publishLive()
    const onSubagent = (ev: { id: string; phase: 'start' | 'update' | 'done'; subagentType?: string; description?: string; prompt?: string; result?: string; isError?: boolean; step?: string }) => {
      const prev = subagents.get(ev.id) ?? { id: ev.id, state: 'running' as const }
      // A `step` appends one of the sub-agent's own tool calls (its live internal activity). Cap the
      // list so a very busy sub-agent can't grow the message unbounded.
      const steps = ev.step ? [...(prev.steps ?? []), ev.step].slice(-40) : prev.steps
      const next: SubagentCard = {
        ...prev,
        subagentType: ev.subagentType ?? prev.subagentType,
        description: ev.description ?? prev.description,
        prompt: ev.prompt ?? prev.prompt,
        result: ev.result ?? prev.result,
        steps,
        state: ev.phase === 'done' ? (ev.isError ? 'error' : 'done') : prev.state,
      }
      subagents.set(ev.id, next)
      syncNativeSubagents()
      publishLive()
      emit({ workspacePath: ws, sessionId: sid, type: 'subagent', id: aid, sub: next })
    }
    // Distillation runs on THIS session's provider. Pick a model valid for it: claude gets the cheap
    // 'haiku-4.5' alias; every other provider falls back to the session's own model (its account
    // default) — feeding a claude-only alias to codex/cursor 400s (model-not-supported).
    const distillModel = distillModelFor(payload.agent) ?? payload.model
    const oneShot: DistillDeps['oneShot'] = (prompt) => new Promise<string>((resolve, reject) => {
      if (!provider.chat) { resolve(''); return }
      let acc = ''
      // The distill one-shot spawns a FRESH provider session, which the CLI persists to its native store
      // (Codex rollout / Claude·qoder project jsonl / opencode storage) — cluttering the user's real
      // session picker with "记忆蒸馏器" threads. Capture the minted native id and delete just that
      // throwaway session once the call ends (fire-and-forget, best-effort; only ever removes our own id).
      let nativeSid = ''
      const cleanup = () => { if (nativeSid) void removeNativeSession(payload.agent, nativeSid) }
      provider.chat({ id: mkId('distill'), prompt, model: distillModel, cwd: ws }, {
        onSession: (id) => { nativeSid = id },
        onAssistantDelta: (t) => { acc += t },
        onThinkDelta: () => {},
        onDone: () => { cleanup(); resolve(acc) },
        onError: (err) => { cleanup(); reject(err) },
      }, env)
    })
    const scheduleDistill = () => {
      if (!memoryOn) return
      const deps: DistillDeps = { oneShot }
      const msgCount = readMessages(ws, sid).length
      if (estimateMessagesTokens(readMessages(ws, sid)) > SESSION_DISTILL_THRESHOLD) void distillSession(ws, sid, deps)
      // workspace 提炼:节流 + 增量。原来【每轮】都把整段历史重发给模型做蒸馏(WORKSPACE_PROMOTE_EVERY_K 常量
      // 早就定义好却从没接线)——是 token 大头。现在每积累 K 条新消息才跑一次,且只喂 [watermark, len) 的增量;
      // 跑完把水位推进到当前消息数(best-effort 完成即推进,失败仅丢这一段增量,可接受)。
      const promotedAt = getSession(ws, sid)?.memPromotedAt ?? 0
      if (msgCount - promotedAt >= WORKSPACE_PROMOTE_EVERY_K) {
        void promoteToWorkspace(ws, sid, deps, promotedAt).then(() => setSessionMemPromoted(ws, sid, msgCount))
      }
      // App/system level is expensive → run only at a low cadence (every K messages). This is the lowest-
      // frequency point that still has a live provider `oneShot`; closeSession has none to run it on.
      if (msgCount > 0 && msgCount % SYSTEM_PROMOTE_EVERY_K === 0) void promoteToSystem(ws, deps)
    }
    // On a SUCCESSFUL turn, advance this provider's watermark to the session's new message count — its
    // native session (if any) now covers everything through this exchange, so a future switch-back only
    // needs to bridge from here. Only meaningful for chat() providers (the only ones that get a native
    // session). Deliberately NOT called on error/abort: the turn may have failed before the provider
    // absorbed the injected context, so advancing the watermark would let a later switch-back see
    // wm >= latest → skip the preamble → silently lose that context with no recovery. Leaving it at the
    // last successful value re-triggers the incremental catch-up next time (a little overlap is fine).
    const bumpWatermark = () => { if (provider.chat) writeWatermark(ws, sid, payload.agent, readMessages(ws, sid).length) }
    const finishOk = (elapsed?: number): ChatMessage => {
      // Fold in skills the agent explicitly NAMED in its reply (home/plugin skills the workspace scan +
      // path-regex miss, e.g. superpowers/brainstorming) so the context panel reflects what it used.
      context = mergeAgentContext(context, { skills: mentionedSkills(text + '\n' + think, cachedInstalledSkills()), rules: [], mcps: [] })
      dbgFinal(text)

      finalizeRunning('done')
      const steps = think.split('\n').map(s => s.trim()).filter(Boolean)
      // Token-usage accounting. Prefer the provider's real reported per-turn usage (turnTokens, from the
      // `result` event). When absent — qoder/codex/cursor/gemini/… don't emit it — fall back to a
      // CJK-aware ESTIMATE so the (workspace × provider × day) 用量 ledger still reflects context
      // consumption for every provider. input ≈ the whole conversation fed to the model this turn
      // (readMessages already includes the just-appended user message, before the reply is appended);
      // output ≈ the reply text. Marked estimated:true so the UI can flag it as approximate.
      const tokens = turnTokens ?? {
        input: readMessages(ws, sid).reduce((sum, m) => sum + estimateContextTokens(m.text), 0),
        output: estimateContextTokens(text),
        estimated: true,
      }
      const msg: ChatMessage = {
        id: aid, who: 'ai', text, model: label, provider: payload.agent, ts: now(),
        think: steps.length ? { label: '已思考', elapsed, steps } : undefined,
        context,
        usage: lastUsage,
        tokens,
        subagents: subagentList(),
        tools: toolList(),
        startedAt, endedAt: Date.now(),
      }
      appendMessage(ws, sid, msg)
      // 成长宠物的实时信号 —— tokens 上面刚算好(真实上报优先,否则 CJK 估算),直接喂给今日计数器。
      // 注意不要改用 aggregateTokenUsage:那是全量扫盘,不能每轮调。
      addDailyTokens((tokens.input || 0) + (tokens.output || 0))
      clearLive(ws, sid, aid) // persisted now covers it — drop the in-flight mirror
      bumpWatermark()
      emit({ workspacePath: ws, sessionId: sid, type: 'done', message: msg })
      scheduleDistill()
      return msg
    }
    const finishErr = (err: Error): ChatMessage => {
      finalizeRunning('error')
      const msg: ChatMessage = { id: aid, who: 'ai', text: text || `错误: ${err.message}`, model: label, provider: payload.agent, ts: now(), subagents: subagentList(), tools: toolList(), startedAt, endedAt: Date.now() }
      // 事件带上落档的 msg。`text` 非空时这一轮其实是「答完了但收尾报错」(provider 先流出了答案,再以非零
      // 退出/stderr 收尾),app 显示的就是这段正文;不带 msg 的话下游只看得到 err.message,只能一律当彻底
      // 失败处理 —— 机器人就是这么把一次有答案的回合报成 ❌ 的。
      emit({ workspacePath: ws, sessionId: sid, type: 'error', id: aid, error: err.message, message: msg })
      appendMessage(ws, sid, msg)
      clearLive(ws, sid, aid)
      scheduleDistill()
      return msg
    }
    const finishAborted = (): ChatMessage => {
      finalizeRunning('error')
      const msg: ChatMessage = { id: aid, who: 'ai', text, model: label, provider: payload.agent, ts: now(), subagents: subagentList(), tools: toolList(), startedAt, endedAt: Date.now() }
      appendMessage(ws, sid, msg)
      clearLive(ws, sid, aid)
      emit({ workspacePath: ws, sessionId: sid, type: 'done', message: msg })
      scheduleDistill()
      return msg
    }

    let aborted = false
    // Diagnostic: capture the raw shape of the assistant deltas (revealing whitespace/newlines) so a
    // "one char/word per line" garble can be traced to the exact stream chunks. Bounded per turn; open
    // 设置 → 调试日志 to read. `via` shows which path emitted it (chat=native stream, run=log fallback).
    let dbgN = 0
    const dbgDelta = (via: string, t: string) => { if (dbgN < 40) { logDebug('chat', `Δ#${dbgN} ${payload.agent}/${via}`, JSON.stringify(t)); dbgN++ } }
    const dbgFinal = (t: string) => logDebug('chat', `final ${payload.agent} len=${t.length}`, JSON.stringify(t.slice(0, 400)))
    // 「停止」时要立刻把伪流式还没放完的文本一次倒完 —— 否则用户喊了停,字还在一个字一个字往外冒。
    // 用 ref 而不是直接引用:wrapSession 定义在这里,而被包的回调要到下面才建出来。
    let flushPaced: (() => void) | null = null
    const wrapSession = (session: AgentSession): AgentSession => ({
      id: session.id,
      done: session.done,
      cancel: () => { aborted = true; flushPaced?.(); session.cancel() },
    })

    if (provider.chat) {
      const sessionId = nativeResumeId ?? readSession(ws, sid, payload.agent)
      return new Promise<ChatMessage>((resolve) => {
        // Guard: a provider may fire BOTH onError and onDone at end-of-turn (e.g. an API error with no
        // assistant text). Only the first settles — otherwise finishOk (empty text) overwrites
        // finishErr's error bubble, leaving a blank reply.
        let settled = false
        // paceAssistantDeltas:把「一整坨突然出现」的回复摊成逐段浮现(见 paceDeltas.ts)。
        // 只有大分片会被摊开 —— claude 那种逐 token 的真流式零延迟穿过去,所以这里可以无条件包一层,
        // 不用维护「哪些 provider 需要」的名单。代价是有积压时 onDone 会晚 ~1 秒到。
        const paced = paceAssistantDeltas({
          onSession: (id) => writeSession(ws, sid, payload.agent, id),
          onAssistantDelta: (t) => { dbgDelta('chat', t); text += t; publishLive(); emit({ workspacePath: ws, sessionId: sid, type: 'assistant-delta', id: aid, text: t }) },
          onAssistantReplace: (full) => { text = full; publishLive(); emit({ workspacePath: ws, sessionId: sid, type: 'assistant-replace', id: aid, text: full }) },
          onThinkDelta: (t) => {
            think += (think ? '\n' : '') + t
            const before = context.skills.length + context.rules.length + (context.mcps?.length ?? 0)
            context = mergeAgentContext(context, extractRuntimeContext(t, ws))
            const after = context.skills.length + context.rules.length + (context.mcps?.length ?? 0)
            publishLive()
            emit({ workspacePath: ws, sessionId: sid, type: 'think-delta', id: aid, text: t, context: after !== before ? context : undefined })
          },
          // Raw startup/runtime logs → live think steps, but NOT accumulated into `think`: they're
          // ephemeral liveness (visible while the turn runs, replaced by the final message on done), so
          // the persisted reasoning stays clean while the spawn/handshake gap no longer looks frozen.
          onStatus: (t) => emit({ workspacePath: ws, sessionId: sid, type: 'think-delta', id: aid, text: t }),
          onConfirm: deps.confirm,
          onUsage: (u) => { lastUsage = u; publishLive() },
          onTurnTokens: (t) => { turnTokens = { input: (turnTokens?.input ?? 0) + t.input, output: (turnTokens?.output ?? 0) + t.output } },
          onSubagent,
          onToolActivity,
          onDone: (r) => { if (settled) return; settled = true; resolve(finishOk(r.elapsed)) },
          onError: (err) => { if (settled) return; settled = true; resolve(aborted ? finishAborted() : finishErr(err)) },
        })
        flushPaced = paced.flushPaced
        const session = provider.chat!({ id: aid, prompt: promptText, model: payload.model, cwd: ws, sessionId, attachments: payload.attachments, permissionMode: payload.permissionMode }, paced, env)
        deps.onSessionStart?.(wrapSession(session))
      })
    }

    return new Promise<ChatMessage>((resolve) => {
      const session = provider.run(
        { stageKey: 'chat', agentId: aid, name: 'chat', prompt: promptText, cwd: ws, model: payload.model },
        {
          onLog: (l) => { if (l.level === 'ok' || (l.level === 'accent' && (l.kind === 'output' || l.kind == null))) { dbgDelta('run', l.text); text += (text ? '\n' : '') + l.text; publishLive(); emit({ workspacePath: ws, sessionId: sid, type: 'assistant-delta', id: aid, text: l.text }) } },
          onState: () => {},
          onConfirm: deps.confirm ?? (async () => 'deny'),
          onInput: async () => '',
          onDone: () => {},
          onError: (err) => resolve(aborted ? finishAborted() : finishErr(err))
        }, env
      )
      deps.onSessionStart?.(wrapSession(session))
      session.done.then(() => resolve(finishOk(undefined))).catch((err) => resolve(aborted ? finishAborted() : finishErr(err as Error)))
    })
  })
}
