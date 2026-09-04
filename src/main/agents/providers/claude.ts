import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model, ChatTask, ChatCallbacks, ConfirmDecision } from '../types'
import type { AskAnswers } from '@shared/types'
import { parseChatStreamActions, buildChatPrompt, extractContextTokens, extractTurnTokens, contextWindowFor, splitThinkLines } from '../chatStream'
import { forgeChatDirective } from '../forgeChatDirective'
import { forgeMcpArgs, forgeAllowedToolNames } from '../mcpConfig'
import { permissionArgs } from '../permissionArgs'
import { readClaudeModelsLive } from './claudeModels'
import { logError, appLog } from '../../log/appLog'
import { makeIdleWatchdog, CHAT_IDLE_MS } from '../idleWatchdog'
import { CLAUDE_CONTROL_FLAGS, controlInitLine, userMessageLine, parseCanUseTool, toolTarget, controlAllowLine, controlDenyLine, parseAskQuestions, controlAnswerLine, askGateTitle, type CanUseTool } from './claudeControl'

// The claude CLI's `--model` only accepts an alias ('opus'/'sonnet'/'haiku'/'fable') or a
// full name ('claude-opus-4-8'). Our friendly ids ('opus-4.8') are display labels and are
// NOT valid CLI args — passing one verbatim makes claude abort with "model may not exist".
// Translate id -> alias at the CLI boundary; pass through anything already valid.
const CLI_MODEL_ALIAS: Record<string, string> = {
  'opus-4.8': 'opus', 'sonnet-4.6': 'sonnet', 'haiku-4.5': 'haiku',
}
export function cliModel(id: string): string { return CLI_MODEL_ALIAS[id] ?? id }

function now() { return new Date().toISOString().slice(11, 19) }

// Benign claude stderr that must NOT be surfaced into the reply (it isn't the assistant's answer):
// print-mode's "no stdin data received in 3s, proceeding without it…" wait warning (we now feed stdin
// immediately so it rarely fires, but filter it defensively), and node process warnings. rawErr still
// keeps everything for the no-reply diagnostic. Mirrors codex's isCodexInternalLog.
export function isClaudeBenignStderr(line: string): boolean {
  return /no stdin data received/i.test(line) || /^\(node:\d+\)\s/.test(line)
}

export interface ClaudeSpec { bin?: string; preArgs?: string[]; defaultModels: Model[] }

// Exported for unit testing. Builds the CLI args for a run() invocation (non-preArgs path).
// Pre-grants the forge MCP tools (forge_handoff/forge_ask) whenever forge is injected: headless
// claude BLOCKS an MCP call unless its name is in --allowedTools, so without this a delegated
// sub-agent can't hand off and degrades to a text "请授权 forge_handoff" reply (mirrors chat()).
// Any task.allowedTools are merged in ahead of the forge names.
export function buildClaudeArgs(task: AgentTask, env: NodeJS.ProcessEnv): string[] {
  const allowed = [...(task.allowedTools ?? []), ...forgeAllowedToolNames(env)]
  const allowedToolsArgs = allowed.length
    ? ['--allowedTools', ...allowed]
    : []
  // Run-path 'readonly' only ever comes from a read-only delegation (delegate.ts:256), whose
  // callbacks hard-deny mutations (onConfirm → 'deny'). Do NOT emit claude's 'plan' mode for it:
  // plan BLOCKS every tool call — including the forge_handoff/forge_ask just pre-granted above —
  // so the sub-agent could never report back and degraded to a text "请授权 forge_handoff" reply.
  // Omit the flag → default ask mode: pre-granted forge tools and read tools run, while mutating
  // tools raise a permission request the delegate denies. (chat() keeps 'plan' — its onConfirm is
  // interactive, so its read-only shield must stay a hard behavioral gate, not a forge-blocking one.)
  const mode = task.permissionMode ?? 'auto'
  const permArgs = mode === 'readonly' ? [] : permissionArgs('claude', mode)
  return [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...CLAUDE_CONTROL_FLAGS,
    ...permArgs,
    ...allowedToolsArgs,
    '--model', cliModel(task.model),
    ...forgeMcpArgs(env),
  ]
}

export function makeClaudeProvider(spec: ClaudeSpec): AgentProvider {
  const bin = spec.bin ?? 'claude'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'claude',
    displayName: 'Claude Code',
    bin,
    capabilities: { structuredOutput: true, permissionHook: true, pty: false, mcpTools: true, liveModels: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    // claude has no --list-models; recover the real alias→version map by scanning its compiled
    // bundle (fail-open to []). Wired through the standard liveModels cache/refresh path in detect.ts.
    async listModelsLive(env: NodeJS.ProcessEnv): Promise<Model[]> { return readClaudeModelsLive(bin, env) },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      let args: string[]
      if (spec.preArgs) {
        args = [...spec.preArgs]
        // preArgs replaces the full arg list (test harness path) — no MCP injection
      } else {
        // --permission-mode acceptEdits: the human already approved the whole run via the hard
        // gate, so stage agents auto-accept file edits within the cwd (the isolated forge/ worktree)
        // instead of blocking on per-edit prompts in headless mode. Scoped to run() only — chat()
        // stays interactive.
        args = buildClaudeArgs(task, env)
      }
      const child: ResultPromise = spawnAgent(bin, args, { cwd: task.cwd, env, reject: false })
      try {
        child.stdin?.write(controlInitLine() + '\n')
        child.stdin?.write(userMessageLine(task.prompt) + '\n')
      } catch { /* stdin gone */ }
      // Under the control protocol (--input-format stream-json) claude holds stdin open for permission
      // responses and NEVER self-exits after its turn — it blocks waiting for a next message that never
      // comes. Two things reclaim it: (1) the `result` event below (the normal end-of-turn signal) kills
      // the child immediately; (2) this inactivity watchdog is the safety net for a genuinely wedged
      // agent that never even emits `result` — without it workOrder's `await session.done` (process
      // exit) would hang the whole workflow lane forever (the 0/N-for-40min wedge). Mirrors chat().
      const wd = makeIdleWatchdog(CHAT_IDLE_MS, () => { try { killTree(child) } catch { /* already gone */ } })
      // Set from the `result` event; overrides the SIGTERM exit code we then raise so a clean turn
      // reports ok:true rather than `退出码 143`.
      let turnOk: boolean | null = null
      let buf = ''
      // Answer a pending can_use_tool control_request on stdin; tolerate a closed/dead stream
      // (e.g. the run was cancelled while a confirm was pending) instead of throwing.
      const respond = (req: CanUseTool, allow: boolean) => {
        try { child.stdin?.write((allow ? controlAllowLine(req) : controlDenyLine(req)) + '\n') } catch { /* stdin gone */ }
      }
      // Answer an AskUserQuestion gate: the picks ride back inside updatedInput (see controlAnswerLine).
      const respondAnswer = (req: CanUseTool, answers: AskAnswers, response?: string) => {
        try { child.stdin?.write(controlAnswerLine(req, answers, response) + '\n') } catch { /* stdin gone */ }
      }
      let streamed = false
      let ctxMaxSeen = 0
      const KIND_LEVEL = { think: 'info', tool: 'accent', file: 'accent', output: 'accent' } as const
      const handle = async (obj: any) => {
        const cut = parseCanUseTool(obj)
        if (cut) {
          // A stage agent can ask the human too (AskUserQuestion rides the permission channel) — lift
          // its options out so the run's 需要授权 card renders a chooser instead of a bare 批准/拒绝.
          const questions = cut.requiresUserInteraction || cut.toolName === 'AskUserQuestion'
            ? parseAskQuestions(cut.input)
            : null
          let decision: ConfirmDecision = 'deny'
          // A permission prompt is a legitimate human wait, not a wedge — suspend the idle watchdog so
          // it can't SIGTERM the agent mid-decision (finally always resumes).
          wd.pause()
          try {
            decision = await cb.onConfirm({
              title: questions ? askGateTitle(questions) : `${cut.toolName} 请求执行`,
              where: toolTarget(cut.input), agentId: cut.agentId, toolName: cut.toolName, toolUseId: cut.toolUseId,
              ...(questions ? { questions } : {}),
            })
          }
          catch (e) { respond(cut, false); cb.onError(e instanceof Error ? e : new Error(String(e))); return }
          finally { wd.resume() }
          if (typeof decision === 'object') respondAnswer(cut, decision.answers ?? {}, decision.response)
          else respond(cut, decision === 'allow')
          return
        }
        const used = extractContextTokens(obj)
        if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) }
        { const tt = extractTurnTokens(obj); if (tt) cb.onTurnTokens?.(tt) }
        if (obj?.type === 'stream_event') streamed = true
        if (obj?.type === 'assistant' && streamed) return   // deltas already streamed this turn; skip the full message to avoid duplicates
        for (const a of parseChatStreamActions(obj)) {
          if (a.kind === 'session') { cb.onSession?.(a.id); continue }
          if (a.kind === 'ignore') continue
          if (a.kind === 'result') {
            if (a.text) cb.onLog({ ts: now(), text: a.text, level: 'ok', kind: 'output' })
            // End of turn. claude won't self-exit (stdin held open), so terminate now — otherwise the
            // lane hangs forever on `await session.done` after the agent already handed off. Capture
            // success from the raw result so the SIGTERM exit code (143) isn't misread as a failure.
            turnOk = (obj as { subtype?: string; is_error?: boolean })?.subtype === 'success' && (obj as { is_error?: boolean })?.is_error !== true
            try { killTree(child) } catch { /* already gone */ }
            continue
          }
          // A stage agent's own built-in Task sub-agents: surface as log lines (the run path has no
          // sub-agent card UI; the workflow's own real sub-agents are the visible ones here).
          if (a.kind === 'subagent-start') { cb.onSubagent?.({ id: a.id, phase: 'start', subagentType: a.subagentType, description: a.description }); cb.onLog({ ts: now(), text: `调用子代理 ${a.subagentType ?? ''}${a.description ? ' · ' + a.description : ''}`.trim(), level: 'accent', kind: 'tool' }); continue }
          if (a.kind === 'subagent-result') { cb.onSubagent?.({ id: a.id, phase: 'done', result: a.result, isError: a.isError }); continue }
          const kind = a.kind === 'assistant' ? 'output' : a.kind
          cb.onLog({ ts: now(), text: a.text, level: KIND_LEVEL[kind], kind })
        }
      }
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch { cb.onLog({ ts: now(), text: line, level: 'info' }); return }
        // If onConfirm throws, deny so claude is never left blocked, and surface the error.
        handle(obj).catch((err) => { cb.onError(err instanceof Error ? err : new Error(String(err))) })
      }
      child.stdout?.on('data', (b: Buffer) => {
        // Any stdout byte means the process is alive — including a long stream of input_json_delta
        // events (a big Write's content) that map to no log line. Beat the local watchdog and signal
        // liveness before parsing so neither this nor the orchestrator watchdog kills a healthy agent
        // mid-generation.
        wd.beat()
        cb.onActivity?.()
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          processLine(line)
        }
      })
      const done = child.then((res) => {
        wd.clear()
        processLine(buf); buf = '' // flush any final line that had no trailing newline (e.g. the result event)
        // A clean `result` (turnOk===true) means success even though we then SIGTERM'd the non-exiting
        // process (exit code 143). Fall back to the exit code only when no result arrived (a wedge the
        // watchdog reclaimed, or a crash) → ok:false so the lane fails/retries rather than false-passes.
        const ok = turnOk ?? (res.exitCode === 0)
        cb.onState(ok ? 'ok' : 'err')
        const result = { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
        cb.onDone(result); return result
      }).catch((err) => { wd.clear(); cb.onState('err'); cb.onError(err as Error); return { ok: false } })
      return { id: task.agentId, cancel: () => { wd.clear(); killTree(child) }, done }
    },
    chat(task: ChatTask, cb: ChatCallbacks, env): AgentSession {
      // claude 主代理靠自动发现的 .claude/skills/forge-workflow 学工作流规则,但那依赖它自行按 frontmatter
      // 决定是否加载,不保证每轮生效(codex/qoder 是每轮强制内联 directive,claude 之前是缺口)。这里与它们
      // 对齐:强制内联 forgeChatDirective 作为「必须真调 forge_propose_plan/forge_delegate、禁止叙述式假执行」
      // 的兜底保证(fail-open:未暴露 forge 工具时 directive 返回 '',行为不变)。
      const directive = forgeChatDirective(env)
      const chatPrompt = directive ? `${directive}\n\n${buildChatPrompt(task)}` : buildChatPrompt(task)
      // `-p --output-format stream-json` REQUIRES --verbose, otherwise claude exits with a
      // usage error and emits nothing → the reply renders blank ("only 思考中, no text").
      // Pre-grant the forge MCP tools; without --allowedTools, claude blocks the call in headless
      // mode ("requested permissions … but you haven't granted it yet") and forge_delegate /
      // forge_propose_plan never run — the chat-delegation "子代理没执行/被取消" bug.
      const forgeAllow = forgeAllowedToolNames(env)
      const allowArgs = forgeAllow.length ? ['--allowedTools', ...forgeAllow] : []
      // Prompt now goes to stdin as a user message (Step 4), NOT an argv positional — required by
      // --input-format stream-json. CLAUDE_CONTROL_FLAGS turns on the can_use_tool control protocol.
      const args = spec.preArgs
        ? [...spec.preArgs]
        : ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...CLAUDE_CONTROL_FLAGS, ...permissionArgs('claude', task.permissionMode ?? 'auto'), ...allowArgs, '--model', cliModel(task.model), ...forgeMcpArgs(env)]
      if (!spec.preArgs && task.sessionId) args.push('--resume', task.sessionId)
      const child: ResultPromise = spawnAgent(bin, args, { cwd: task.cwd, env, reject: false })
      // Control-protocol handshake + prompt delivery (must come before we await output).
      try {
        child.stdin?.write(controlInitLine() + '\n')
        child.stdin?.write(userMessageLine(chatPrompt) + '\n')
      } catch { /* stdin gone — the turn will error out and be reported normally */ }
      // Inactivity watchdog: reclaim a genuinely wedged turn (240s of total silence) instead of an
      // endless 思考中 spinner — but never kill a long, still-streaming turn.
      const wd = makeIdleWatchdog(CHAT_IDLE_MS, () => { try { killTree(child) } catch { /* already gone */ } })
      const start = Date.now()
      let buf = ''
      let streamed = false
      let sawAssistant = false   // any assistant text produced this turn
      let sawTool = false        // any tool/file action (e.g. forge_propose_plan → a plan card, NOT an empty reply)
      // Set from the `result` event; like run(), it overrides the SIGTERM exit code we then raise so a
      // clean turn isn't misreported as `退出码 143`.
      let turnOk: boolean | null = null
      let rawErr = ''            // captured stderr for the no-reply diagnostic
      let errBuf = ''            // stderr line-splitter for live onStatus forwarding
      let ctxMaxSeen = 0
      const cap = (s: string, add: string) => (s + add).slice(-2000)
      // Answer a pending can_use_tool control_request on stdin. Tolerate a closed/dead stream (e.g.
      // the turn was cancelled while a gate was open).
      const respond = (req: CanUseTool, allow: boolean) => {
        try { child.stdin?.write((allow ? controlAllowLine(req) : controlDenyLine(req)) + '\n') } catch { /* stdin gone */ }
      }
      // Answer an AskUserQuestion gate: the picks ride back inside updatedInput (see controlAnswerLine).
      const respondAnswer = (req: CanUseTool, answers: AskAnswers, response?: string) => {
        try { child.stdin?.write(controlAnswerLine(req, answers, response) + '\n') } catch { /* stdin gone */ }
      }
      // Track which tool_use ids are Task sub-agents so their tool_result can be correlated; dedupe the
      // two start sources (empty-input content_block_start, then the full assistant message) — first
      // is 'start', later enrichment is 'update'. A running sub-agent counts as activity (not "no reply").
      const subagentIds = new Set<string>()
      // Reasoning arrives as word-level `thinking_delta` fragments (--include-partial-messages), so
      // buffer them and only emit whole lines — otherwise the think panel shows one word per line
      // (chatService joins each delta with '\n'). Discrete steps (assistant text / tool labels) flush
      // the buffer first so any trailing reasoning line stays intact on its own line. Mirrors qoder.ts.
      let thinkBuf = ''
      const pushThink = (t: string) => {
        const { lines, rest } = splitThinkLines(thinkBuf + t)
        for (const l of lines) cb.onThinkDelta(l)
        thinkBuf = rest
      }
      const flushThink = () => { const t = thinkBuf.trim(); thinkBuf = ''; if (t) cb.onThinkDelta(t) }
      const onSubagent = (a: { id: string; subagentType?: string; description?: string; prompt?: string }) => {
        sawTool = true
        const phase = subagentIds.has(a.id) ? 'update' as const : 'start' as const
        subagentIds.add(a.id)
        cb.onSubagent?.({ id: a.id, phase, subagentType: a.subagentType, description: a.description, prompt: a.prompt })
      }
      const handle = async (obj: any) => {
        const cut = parseCanUseTool(obj)
        if (cut) {
          // AskUserQuestion isn't an operation to approve — it's the model ASKING the human, smuggled
          // through the permission channel. Lift its options out so the gate renders as a chooser
          // instead of an opaque "AskUserQuestion 请求执行 / 允许 / 拒绝" (where 允许 answered nothing
          // and the model was told "The user did not answer the questions").
          const questions = cut.requiresUserInteraction || cut.toolName === 'AskUserQuestion'
            ? parseAskQuestions(cut.input)
            : null
          // Fail-closed: no handler OR a thrown/torn-down gate → DENY. Never leave the CLI waiting on
          // a control_response (that hangs the turn). agentId routes the gate to the right lane.
          let decision: ConfirmDecision = 'deny'
          // Pause the inactivity watchdog while the user decides — a permission prompt is a human wait,
          // not a wedged turn, so it must not be killed by the 240s idle timer (finally always resumes).
          wd.pause()
          try {
            if (cb.onConfirm) decision = await cb.onConfirm({
              title: questions ? askGateTitle(questions) : `${cut.toolName} 请求执行`,
              where: toolTarget(cut.input), agentId: cut.agentId, toolName: cut.toolName,
              ...(questions ? { questions } : {}),
            })
          }
          catch (e) { respond(cut, false); cb.onError(e instanceof Error ? e : new Error(String(e))); return }
          finally { wd.resume() }
          if (typeof decision === 'object') respondAnswer(cut, decision.answers ?? {}, decision.response)
          else respond(cut, decision === 'allow')
          return
        }
        // A sub-agent's OWN internal event: claude tags it with a top-level parent_tool_use_id = the Task
        // tool_use id that spawned it (main-turn events have it null/absent). Attribute the sub-agent's
        // tool calls to that Task's card as live steps — and RETURN so they don't leak into the main
        // turn's 执行 block (the parser is parent-agnostic). Read from the full `assistant` message (full
        // tool input → good titles); the partial stream_event for the same tool is skipped. We only get
        // tool_use/tool_result for sub-agents by default (text/thinking需 --forward-subagent-text).
        const parentId = typeof obj?.parent_tool_use_id === 'string' ? obj.parent_tool_use_id : null
        if (parentId) {
          if (obj.type === 'assistant') {
            for (const action of parseChatStreamActions(obj)) {
              if (action.kind === 'tool' || action.kind === 'file') cb.onSubagent?.({ id: parentId, phase: 'update', step: action.text })
            }
          }
          return
        }
        const used = extractContextTokens(obj)
        if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) }
        { const tt = extractTurnTokens(obj); if (tt) cb.onTurnTokens?.(tt) }
        if (obj?.type === 'stream_event') streamed = true
        // deltas already streamed the assistant text; skip its text to avoid duplication — but STILL
        // extract Task sub-agent blocks, which only appear (with full input) in this message, not the
        // partial stream events.
        if (obj?.type === 'assistant' && streamed) {
          for (const action of parseChatStreamActions(obj)) {
            if (action.kind === 'subagent-start') onSubagent(action)
          }
          return
        }
        // End of turn. claude under --input-format stream-json holds stdin open (needed to answer
        // permission control_requests) and does NOT self-exit after its turn — so without this the chat
        // turn hangs `busy` until the 240s idle watchdog: the user can't reply (their message just
        // queues) and has to hit 停止. Terminate on the `result` event (claude's authoritative end-of-turn
        // signal), mirroring run(). It arrives only AFTER every tool/permission gate, so this never cuts a
        // pending gate short. Success comes from the raw result so the SIGTERM exit (143) isn't misread.
        if (obj?.type === 'result') {
          turnOk = (obj as { subtype?: string; is_error?: boolean }).subtype === 'success' && (obj as { is_error?: boolean }).is_error !== true
          try { killTree(child) } catch { /* already gone */ }
          return
        }
        for (const action of parseChatStreamActions(obj)) {
          if (action.kind === 'session') cb.onSession(action.id)
          else if (action.kind === 'assistant') { flushThink(); sawAssistant = true; cb.onAssistantDelta(action.text) }
          else if (action.kind === 'think') pushThink(action.text)
          else if (action.kind === 'tool' || action.kind === 'file') {
            flushThink()
            sawTool = true
            // A correlatable tool call → the "执行" block (title now, output paired by id on its result).
            // Without an id (can't pair a result) fall back to the old think-step so it's still visible.
            if (action.id) cb.onToolActivity?.({ id: action.id, phase: 'start', name: action.name, title: action.text })
            else cb.onThinkDelta(action.text)
          }
          else if (action.kind === 'subagent-start') onSubagent(action)
          else if (action.kind === 'subagent-result') {
            // parseChatStreamActions emits a 'subagent-result' for EVERY tool_result. A known Task id →
            // its sub-agent card; any other id → a regular tool's output, into the 执行 block.
            if (subagentIds.has(action.id)) cb.onSubagent?.({ id: action.id, phase: 'done', result: action.result, isError: action.isError })
            else cb.onToolActivity?.({ id: action.id, phase: 'done', output: action.result, isError: action.isError })
          }
        }
      }
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch { sawAssistant = true; cb.onAssistantDelta(line); return }
        handle(obj).catch((err) => { cb.onError(err instanceof Error ? err : new Error(String(err))) })
      }
      child.stdout?.on('data', (b: Buffer) => {
        wd.beat()
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); processLine(line) }
      })
      child.stderr?.on('data', (b: Buffer) => {
        wd.beat()
        const s = b.toString()
        rawErr = cap(rawErr, s)
        // Stream stderr live, line by line, into the think block so startup/handshake activity shows.
        errBuf += s
        let nl: number
        while ((nl = errBuf.indexOf('\n')) >= 0) { const line = errBuf.slice(0, nl).trim(); errBuf = errBuf.slice(nl + 1); if (line && !isClaudeBenignStderr(line)) cb.onStatus?.(line) }
      })
      const done = child.then((res) => {
        wd.clear()
        processLine(buf); buf = ''
        flushThink()   // surface any trailing reasoning line that never got a closing newline
        if (errBuf.trim() && !isClaudeBenignStderr(errBuf.trim())) { cb.onStatus?.(errBuf.trim()) } errBuf = ''
        const elapsed = Math.round((Date.now() - start) / 1000)
        // No assistant text at all → surface a diagnostic instead of a silent blank bubble (and leave
        // a trail in the debug log, mirroring codex/opencode). Killed-for-silence gets the clearest note.
        if (!sawAssistant && !sawTool) {
          const clip = args.map(a => { const s = String(a); return s.length > 160 ? s.slice(0, 160) + `…(+${s.length - 160})` : s }).join(' ')
          let diag = wd.firedFlag
            ? 'claude 长时间无响应（240s 无任何输出）已终止 —— 可尝试拆分过长的输入或检查网络'
            : rawErr.trim() ? `claude stderr:\n${rawErr.trim()}` : `claude 无输出 (退出码 ${res.exitCode})`
          logError('claude', 'chat 无回复', `cmd: ${bin} ${clip}\ncwd: ${task.cwd}\n${diag}`)
          cb.onError(new Error(diag))
          return { ok: false, summary: diag }
        }
        // Per-turn end-condition breadcrumb (filter the debug log by scope 'claude'). A clean but
        // PREMATURE exit — output truncated while claude looked done — otherwise leaves no trace; this
        // records exit code, elapsed, whether any text/tool was seen, and whether the idle watchdog
        // fired, so a truncation report can be pinned to its actual cause.
        appLog('info', 'claude', `chat 结束 · 退出码 ${res.exitCode} · ${elapsed}s · 文本=${sawAssistant} 工具=${sawTool} result收尾=${turnOk != null} 看门狗=${wd.firedFlag}`)
        cb.onDone({ elapsed })
        // A clean `result` (turnOk===true) is success even though we then SIGTERM'd the non-exiting
        // process (exit 143); fall back to the exit code only when no result arrived.
        const ok = turnOk ?? (res.exitCode === 0)
        return { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
      }).catch((err) => { wd.clear(); cb.onError(err as Error); return { ok: false } })
      return { id: task.id, cancel: () => { wd.clear(); killTree(child) }, done }
    }
  }
}
