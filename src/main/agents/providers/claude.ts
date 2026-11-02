import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, AgentResult, Model, ChatTask, ChatCallbacks, ChatBackgroundHooks, ConfirmDecision } from '../types'
import type { AskAnswers } from '@shared/types'
import type { PermissionMode } from '@shared/permissions'
import { providerSupportsBrowserUse, BROWSER_TOOL_PREFIX } from '@shared/browserUse'
import { parseChatStreamActions, buildChatPrompt, extractContextTokens, extractTurnTokens, makeUsageTracker, splitThinkLines } from '../chatStream'
import { forgeChatDirective } from '../forgeChatDirective'
import { forgeMcpArgs, forgeAllowedToolNames } from '../mcpConfig'
import { permissionArgs } from '../permissionArgs'
import { readClaudeModelsLive } from './claudeModels'
import { logError, appLog } from '../../log/appLog'
import { makeIdleWatchdog, CHAT_IDLE_MS, CHAT_STALL_KILL_MS, type IdleWatchdog } from '../idleWatchdog'
import { makeHookWatch, HOOK_SLOW_MS } from './claudeHooks'
import { makeBackgroundGate, parseTaskNotification, isReplayedNotificationResult } from './claudeBackground'
import { CLAUDE_CONTROL_FLAGS, controlInitLine, userMessageLine, parseCanUseTool, toolTarget, controlAllowLine, controlDenyLine, parseAskQuestions, controlAnswerLine, askGateTitle, gateTitle, unhandledControlRequest, controlErrorLine, setModelLine, setPermissionModeLine, parseControlResponse, type CanUseTool } from './claudeControl'

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

/**
 * 一轮已经在界面上结束、但进程还留着跑后台任务的 claude(见 chat() 里的 detach)。
 * 键是 cwd + claude 的会话 id。★下一条消息直接写进它的 stdin(attach),后台任务不受影响;
 * 只有它已经在被回收、或者 spawn 参数变了且后台已经没活时,才收掉再 --resume(见文件末尾)。
 */
interface LingeringChat {
  /** 杀整棵树,等它真退出。 */
  stop(): Promise<void>
  /** 已经决定回收(停止 / 宽限期满)的进程不能再接消息。 */
  alive(): boolean
  running(): number
  /** spawn 时定死、控制协议改不了的那部分参数。 */
  readonly signature: string
  attach(task: ChatTask, cb: ChatCallbacks, prompt: string, flagsDeferred: boolean): AgentSession
  /** 不等下一条消息,现在就把权限档切到这个进程上。返回要告诉用户的话(没有就是 null)。 */
  setPermission(mode: PermissionMode): Promise<string | null>
}
const lingering = new Map<string, LingeringChat>()
/** 所有活着的聊天进程(不管这一刻有没有在跑的一轮)。切权限档要够得到正在跑自己那一轮的进程,lingering 里没有它。 */
const liveChats = new Map<string, LingeringChat>()
const lingerKey = (cwd: string, sessionId: string) => `${cwd}\0${sessionId}`
/** 收掉留在后台的进程时最多等它退出多久(实测 SIGTERM 后 ~1s 退出)。 */
const LINGER_STOP_WAIT_MS = 5_000
/** 等 set_model / set_permission_mode 的回复最多多久(实测同一毫秒就回)。 */
const CONTROL_REPLY_WAIT_MS = 3_000

/** 这些环境变量进程起来就钉死了:代理改对了,活进程还是走旧的。 */
const SPAWN_ENV_KEY = /(^|_)proxy$|^TZ$|^ANTHROPIC_|^CLAUDE_/i
/** 去掉能靠控制协议现场改的两项(实测 2.1.312:set_model / set_permission_mode),剩下的变了才算「参数变了」。 */
export function chatSpawnSignature(args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '--permission-mode') { i++; continue }
    rest.push(args[i])
  }
  const envPart = Object.keys(env).filter(k => SPAWN_ENV_KEY.test(k)).sort().map(k => `${k}=${env[k]}`)
  return JSON.stringify([rest, envPart])
}
/** 权限档从松到严:切严失败时绝不能拿旧的松档继续干活。 */
const PERM_RANK: Record<string, number> = { plan: 0, acceptEdits: 1, bypassPermissions: 2 }
const permLabel = (m: string) => (m === 'plan' ? '只读' : m === 'bypassPermissions' ? '完全访问' : '自动')
const UNSENT_MESSAGE = '这条消息没有发出，请重发。'
const cliPermissionMode = (task: ChatTask) => permissionArgs('claude', task.permissionMode ?? 'auto')[1]

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
    // ★★run() 这条路(工作流阶段代理 / forge_delegate 子代理)**还没有**浏览器开关这个功能——没有
    //  UI、没有落盘。但「没有功能」不等于「继承用户在 ~/.claude/settings.json 里的全局 Chrome
    //  设置」:那样的话,只在 chat() 里关掉开关完全挡不住 run() 这条路悄悄带着浏览器工具跑,
    //  Forge 的开关就不再是权威的(见 buildClaudeChatArgs 同一句注释)。所以这里无条件传
    //  `--no-chrome`,等 run() 真的接上这个功能那天再改成按 task 的档位决定。
    '--no-chrome',
    '--model', cliModel(task.model),
    ...forgeMcpArgs(env),
  ]
}

/**
 * chat() 的命令行参数。导出是为了能直接单测 —— `preArgs` 会把整个 argv 替换掉,走那条路测不到这里。
 * 与 run() 的 buildClaudeArgs(上面)对称。
 */
export function buildClaudeChatArgs(task: ChatTask, env: NodeJS.ProcessEnv, chatPrompt: string): string[] {
  const forgeAllow = forgeAllowedToolNames(env)
  const allowArgs = forgeAllow.length ? ['--allowedTools', ...forgeAllow] : []
  // ★★关的时候**显式**传 `--no-chrome`,不能靠「不传」:用户可能在 ~/.claude/settings.json 里
  //   全局开了 Chrome 集成,那样界面上明明是关的、实际却开着。Forge 的开关必须是权威的。
  const chromeArgs = [task.browserUse === 'ask' || task.browserUse === 'allow' ? '--chrome' : '--no-chrome']
  return [
    '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    ...CLAUDE_CONTROL_FLAGS,
    ...permissionArgs('claude', task.permissionMode ?? 'auto'),
    ...allowArgs,
    ...chromeArgs,
    '--model', cliModel(task.model),
    ...forgeMcpArgs(env),
  ]
}

export function makeClaudeProvider(spec: ClaudeSpec): AgentProvider {
  const bin = spec.bin ?? 'claude'
  const defaultModels: Model[] = spec.defaultModels ?? []
  const claudeChatPrompt = (task: ChatTask, env: NodeJS.ProcessEnv) => {
    const directive = forgeChatDirective(env)
    return directive ? `${directive}\n\n${buildChatPrompt(task)}` : buildChatPrompt(task)
  }
  const claudeSpawnArgs = (task: ChatTask, env: NodeJS.ProcessEnv) =>
    spec.preArgs ? [...spec.preArgs] : buildClaudeChatArgs(task, env, claudeChatPrompt(task, env))
  const provider: AgentProvider = {
    id: 'claude',
    displayName: 'Claude Code',
    bin,
    // browserUse 从 shared/browserUse.ts 的 BROWSER_USE_PROVIDERS 推导,不在这里硬编码 true ——
    // 否则「哪些 provider 支持」会在主进程和渲染进程两处各写一份,早晚漂移。
    capabilities: { structuredOutput: true, permissionHook: true, pty: false, mcpTools: true, liveModels: true, browserUse: providerSupportsBrowserUse('claude') },
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
      // ★同 chat():后台子代理/后台命令没跑完时 result 不杀,停车等 CLI 自己起下一轮(见 claudeBackground.ts)。
      //   run 这条路上上面的看门狗照旧:停车期间 240s 一声不出也会回收 —— 工作流泳道不能无限期挂着。
      const bg = makeBackgroundGate({
        onFinish: () => { try { killTree(child) } catch { /* already gone */ } },
        onPark: (n) => cb.onLog({ ts: now(), level: 'info', kind: 'think', text: n > 0 ? `后台还有 ${n} 个任务在跑，等它们完成后继续。` : '后台任务刚完成，等主代理继续…' }),
      })
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
      const usage = makeUsageTracker(u => cb.onUsage?.(u))
      const KIND_LEVEL = { think: 'info', tool: 'accent', file: 'accent', output: 'accent' } as const
      // run 没有子代理卡片 UI,子代理只出日志行;记下哪些 tool_use_id 是子代理,好把后台完成通知对上号。
      const subagentIds = new Set<string>()
      const handle = async (obj: any) => {
        bg.feed(obj)
        const tn = parseTaskNotification(obj)
        if (tn?.toolUseId && subagentIds.has(tn.toolUseId)) {
          cb.onSubagent?.({ id: tn.toolUseId, phase: 'done', result: tn.summary, isError: !tn.ok })
          cb.onLog({ ts: now(), text: `后台子代理${tn.ok ? '完成' : '失败'}${tn.summary ? ' · ' + tn.summary.slice(0, 200) : ''}`, level: tn.ok ? 'ok' : 'info', kind: 'tool' })
        }
        // ★★不认识但对面正等着回答的控制请求:明确回一句「不支持」。原来它会一路掉过所有分支、
        //   **根本没人回答**,claude 就静静地等,这一轮挂住(和 codex 那个 bug 同一类,见 4c6423e)。
        const stray = unhandledControlRequest(obj)
        if (stray) {
          try { child.stdin?.write(controlErrorLine(stray.requestId, `myFlowForge does not support control_request ${stray.subtype}`) + '\n') } catch { /* stdin gone */ }
          cb.onLog({ ts: now(), level: 'info', kind: 'think', text: `claude 发来一个 Forge 不支持的控制请求(${stray.subtype}),已回复不支持并继续。` })
          return
        }
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
              title: questions ? askGateTitle(questions) : gateTitle(cut.toolName),
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
        usage.feed(obj)
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
            bg.result()   // 没有后台活 → 立即 killTree;有 → 停车,下一轮的 result 再判
            continue
          }
          // A stage agent's own built-in Task sub-agents: surface as log lines (the run path has no
          // sub-agent card UI; the workflow's own real sub-agents are the visible ones here).
          if (a.kind === 'subagent-start') {
            subagentIds.add(a.id)
            cb.onSubagent?.({ id: a.id, phase: 'start', subagentType: a.subagentType, description: a.description }); cb.onLog({ ts: now(), text: `调用子代理 ${a.subagentType ?? ''}${a.description ? ' · ' + a.description : ''}`.trim(), level: 'accent', kind: 'tool' }); continue
          }
          if (a.kind === 'subagent-result') {
            // 后台启动回执不是完成:等 task_notification(handle 开头)再报 done
            if (subagentIds.has(a.id) && !a.isError && bg.isBackgroundLaunch(a.id, a.result)) { cb.onLog({ ts: now(), text: '子代理已转入后台运行', level: 'info', kind: 'tool' }); continue }
            cb.onSubagent?.({ id: a.id, phase: 'done', result: a.result, isError: a.isError }); continue
          }
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
        bg.clear()
        // A clean `result` (turnOk===true) means success even though we then SIGTERM'd the non-exiting
        // process (exit code 143). Fall back to the exit code only when no result arrived (a wedge the
        // watchdog reclaimed, or a crash) → ok:false so the lane fails/retries rather than false-passes.
        const ok = turnOk ?? (res.exitCode === 0)
        cb.onState(ok ? 'ok' : 'err')
        const result = { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
        cb.onDone(result); return result
      }).catch((err) => { wd.clear(); bg.clear(); cb.onState('err'); cb.onError(err as Error); return { ok: false } })
      return { id: task.agentId, cancel: () => { wd.clear(); bg.clear(); killTree(child) }, done }
    },
    chat(task: ChatTask, firstCb: ChatCallbacks, env): AgentSession {
      // claude 主代理靠自动发现的 .claude/skills/forge-workflow 学工作流规则,但那依赖它自行按 frontmatter
      // 决定是否加载,不保证每轮生效(codex/qoder 是每轮强制内联 directive,claude 之前是缺口)。这里与它们
      // 对齐:强制内联 forgeChatDirective 作为「必须真调 forge_propose_plan/forge_delegate、禁止叙述式假执行」
      // 的兜底保证(fail-open:未暴露 forge 工具时 directive 返回 '',行为不变)。
      const chatPrompt = claudeChatPrompt(task, env)
      // `-p --output-format stream-json` REQUIRES --verbose, otherwise claude exits with a
      // usage error and emits nothing → the reply renders blank ("only 思考中, no text").
      // Pre-grant the forge MCP tools; without --allowedTools, claude blocks the call in headless
      // mode ("requested permissions … but you haven't granted it yet") and forge_delegate /
      // forge_propose_plan never run — the chat-delegation "子代理没执行/被取消" bug.
      // Prompt now goes to stdin as a user message (Step 4), NOT an argv positional — required by
      // --input-format stream-json. CLAUDE_CONTROL_FLAGS turns on the can_use_tool control protocol.
      // args 的拼装挪进了 buildClaudeChatArgs(导出、可单测) —— preArgs 会把整个 argv 替换掉,
      // 走那条路测不到真实拼装分支,所以必须抽出来才能测到 --chrome/--no-chrome 的分支。
      const args = claudeSpawnArgs(task, env)
      const signature = chatSpawnSignature(args, env)
      if (!spec.preArgs && task.sessionId) args.push('--resume', task.sessionId)
      const child: ResultPromise = spawnAgent(bin, args, { cwd: task.cwd, env, reject: false })
      // Control-protocol handshake + prompt delivery (must come before we await output).
      try {
        child.stdin?.write(controlInitLine() + '\n')
        child.stdin?.write(userMessageLine(chatPrompt) + '\n')
      } catch { /* stdin gone — the turn will error out and be reported normally */ }
      // ★进程可以比一轮活得久,下面这些是「当前这一轮」的状态:下一条消息接到这个进程上时由 beginTurn 全部换新。
      let cb = firstCb
      let background: ChatBackgroundHooks | undefined = task.background
      let turnSeq = 0
      // Inactivity watchdog: reclaim a genuinely wedged turn (240s of total silence) instead of an
      // endless 思考中 spinner — but never kill a long, still-streaming turn.
      /**
       * ★★静默**先报告,不直接杀**。原来是 240 秒没输出就无声 SIGTERM —— 而静默是有歧义的:
       *  可能在算,也可能在等一个我们看不见的人(外部钩子、浏览器 OAuth、sudo、git 凭据)。
       *  用户装的 PermissionRequest 钩子超时是 24 小时,我们 4 分钟就杀,差 360 倍,必然撞车。
       *  现在:4 分钟说一声(能说出还有哪个钩子没回来),半小时还是没动静才回收。
       */
      const makeTurnWatchdog = () => makeIdleWatchdog(CHAT_IDLE_MS, () => {
        const waiting = hooks.pending()
        cb.onStatus?.(waiting.length
          ? `⏳ 已经 ${Math.round(CHAT_IDLE_MS / 1000)}s 没有任何输出，还在等 ${waiting.join('、')} 钩子 —— 它可能正在别处等你确认。要停就点上面的停止。`
          : `⏳ 已经 ${Math.round(CHAT_IDLE_MS / 1000)}s 没有任何输出。可能在等一个 Forge 看不见的确认（外部钩子 / 浏览器授权 / sudo）。要停就点上面的停止。`)
      }, undefined, {
        hardMs: CHAT_STALL_KILL_MS,
        onDeadline: () => {
          // ★后台任务还在跑就不杀:只把这一轮收尾、输入框放开,后台活留着(用户要停有后台任务那个停止)。
          if (bg.running > 0) { cb.onStatus?.('⚠ 这一轮太久没有任何输出，已先收尾，后台任务继续跑。'); bg.result(); return }
          cb.onStatus?.('⚠ 太久没有任何输出，已回收这一轮。'); try { killTree(child) } catch { /* already gone */ }
        },
      })
      let wd: IdleWatchdog
      /**
       * ★★后台子代理/后台命令比主代理这一轮活得久时,`result` 不能直接杀进程 —— 见 claudeBackground.ts。
       * ★★但这一轮在界面上必须就此结束(detach):原来是停车等后台任务,整轮一直显示「运行中」——
       *  主代理最后给了一张 A/B/C 选项表等用户挑,用户打的字却只能排队,只好手动停止(用户 2026-10-30)。
       * ★★进程留着把任务跑完,而且**没有墙钟上限**:用户的后台代理一跑几个小时。三件事接着发生(真 claude 2.1.312 实录):
       *  - 下一条消息直接写进这个进程的 stdin(attach),后台任务毫发无损,回复照常归那条消息;
       *  - 任务跑完 CLI 自己起一轮(result 带 origin.kind = task-notification),由 openTurn 开一条新的回复消息;
       *  - 后台没活、也没有待消化的通知 → 宽限期后回收(BG_GRACE_MS),用户点停止 → 杀整棵树。
       * 没给 background 的调用方(蒸馏 / 总结这些一次性调用)没人能看也没人能停,保留 30 分钟上限和丢弃输出;
       * 共商席位带 endWithTurn:一轮结束就杀,不留(见 ChatTask.endWithTurn)。
       */
      let detached = false
      let dying = false
      let lingerCap: ReturnType<typeof setTimeout> | null = null
      const bg = makeBackgroundGate({
        onFinish: () => { dying = true; try { killTree(child) } catch { /* already gone */ } },
        onPark: () => detach(),
      })
      let reportedRunning = 0
      const stopTree = () => {
        if (dying || exited) return
        dying = true
        adoptGen++       // 停了就是停了:还排着队没开的那条回复不再开
        wd.clear(); hooks.clear(); bg.clear()
        appLog('info', 'claude', `chat 停止后台进程 · 还有 ${bg.running} 个任务`)
        try { killTree(child) } catch { /* already gone */ }
        reportRunning(0)
      }
      const reportRunning = (n: number) => {
        if (n === reportedRunning) return
        reportedRunning = n
        // ★n=0 也给 stopTree:任务跑完了,CLI 自己那一轮可能还在跑,关会话时要够得到它。
        background?.onRunning(n, stopTree)
      }
      /**
       * ★★钩子把这一轮拖住时,界面上和「模型在思考」完全一样 —— 用户 2026-09-07 是靠**另一个软件**
       *  才知道 agent 在等他授权的(那台机器上 PermissionRequest 挂着 3 个钩子,超时 24 小时)。
       *  claude 本来就在流上发钩子的开始/结束,我们一直全丢了;接上之后卡住的那几秒钟能说出是谁在占着,
       *  钩子报错(treland 连不上 socket、ping-island 抛错)也终于看得见了。
       * ★用 onStatus 而不是 onThinkDelta:这是**此刻的状态**,不该沉到落盘的思考记录里。 */
      const makeTurnHooks = () => makeHookWatch({
        slowMs: HOOK_SLOW_MS,
        onSlow: (names, secs) => cb.onStatus?.(`⏳ 等 ${names.join('、')} 钩子响应 · 已 ${secs}s（钩子可能正在别处等你确认）`),
        onError: (name, msg) => cb.onStatus?.(`⚠ ${name} 钩子失败：${msg}`),
      })
      let hooks: ReturnType<typeof makeTurnHooks>
      let start = Date.now()
      let settled = false
      let settle: (r: AgentResult) => void = () => {}
      let done: Promise<AgentResult>
      let nativeSid: string | null = task.sessionId ?? null
      const self: LingeringChat = {
        signature,
        stop: () => {
          stopTree()
          return Promise.race([child.then(() => {}, () => {}), new Promise<void>(r => setTimeout(r, LINGER_STOP_WAIT_MS))])
        },
        alive: () => !dying && !exited,
        running: () => bg.running,
        attach: (next, nextCb, prompt, flagsDeferred) => attach(next, nextCb, prompt, flagsDeferred),
        setPermission: async (mode) => {
          const want = permissionArgs('claude', mode)[1]
          const r = await applyPermission(want)
          return r.failed ? `⚠ 还在跑的进程没能切到「${permLabel(want)}」，它仍按「${permLabel(curPerm)}」跑。要停就点停止。` : (r.note ?? null)
        },
      }
      const trackLive = () => { if (nativeSid) liveChats.set(lingerKey(task.cwd, nativeSid), self) }
      const untrackLive = () => { if (nativeSid && liveChats.get(lingerKey(task.cwd, nativeSid)) === self) liveChats.delete(lingerKey(task.cwd, nativeSid)) }
      const clearLingerKey = () => { if (nativeSid && lingering.get(lingerKey(task.cwd, nativeSid)) === self) lingering.delete(lingerKey(task.cwd, nativeSid)) }
      const parkInMap = () => {
        if (!nativeSid) return
        const key = lingerKey(task.cwd, nativeSid)
        const old = lingering.get(key)
        if (old && old !== self) void old.stop()
        lingering.set(key, self)
      }
      const parkProcess = () => {
        parkInMap()
        // 没人看得见、也没人停得了的调用方:后台留得再久也有个头。有 UI 的聊天没有墙钟上限。
        if (!background) lingerCap = setTimeout(() => { try { killTree(child) } catch { /* already gone */ } }, CHAT_STALL_KILL_MS)
      }
      // 这一轮以失败收场、进程留着。正文已有字时错误不会显示出来(finishErr 优先用正文),所以写进正文。
      const failTurn = (why: string) => {
        pendingLine = null; holdForAuto = false; ctlWaiting = false
        detached = true
        wd.clear(); hooks.clear()
        flushThink()
        if (sawAssistant) cb.onAssistantDelta(`\n\n⚠ ${why}`)
        cb.onError(new Error(why))
        settle({ ok: false, summary: why })
        parkProcess()
      }
      const detach = () => {
        if (detached) return
        // ★用户消息还压着没写就要收尾(CLI 自己那一轮 30 分钟没动静):绝不能当作答完了,消息等于凭空消失。
        if (pendingLine) { failTurn(UNSENT_MESSAGE); return }
        detached = true
        wd.clear(); hooks.clear()
        flushThink()
        const elapsed = Math.round((Date.now() - start) / 1000)
        appLog('info', 'claude', `chat 结束 · result 收尾 · ${elapsed}s · 后台还有 ${bg.running} 个任务,进程留在后台跑完`)
        // 一个字没说就结束(比如报错的 result):走和进程退出同一套诊断,不留空气泡。
        if (!sawAssistant && !sawTool) settle(finishOnExit({}))
        else { cb.onDone({ elapsed }); settle({ ok: turnOk ?? true, summary: '完成' }) }
        parkProcess()
      }
      // --resume 时 claude 先重放上个进程留下的后台任务通知,并为它空跑一轮(见 isReplayedNotificationResult)。
      let sawNotification = false
      let buf = ''
      let streamed = false
      let sawAssistant = false   // any assistant text produced this turn
      let sawTool = false        // any tool/file action (e.g. forge_propose_plan → a plan card, NOT an empty reply)
      // Set from the `result` event; like run(), it overrides the SIGTERM exit code we then raise so a
      // clean turn isn't misreported as `退出码 143`.
      let turnOk: boolean | null = null
      let resultError = ''       // 报错的 result 带的原文,诊断时比「退出码」有用
      // 用户消息到的时候 CLI 正在跑它自己起的那一轮:实录里写进去的消息会被吸进那一轮(只出一个 result),
      // 归属就乱了 —— 所以压到那一轮的 result 再写,回复才归这条消息。needSep 把两段隔开。
      // 模型 / 权限档的控制回复回来之前同样不写(只读不能晚一拍)。这两件事都过了才真正写进 stdin。
      let pendingLine: string | null = null
      let holdForAuto = false
      let ctlWaiting = false
      let needSep = false
      const flushPending = () => {
        if (!pendingLine || holdForAuto || ctlWaiting) return
        try { child.stdin?.write(pendingLine + '\n') } catch { /* stdin gone */ }
        pendingLine = null
        needSep = sawAssistant
      }
      // detach 之后 CLI 自己起的那一轮:有内容才开消息(空的一轮不留空气泡),开之前的事件都攒着回放。
      let autoActive = false
      let autoBuf: any[] = []
      let adoptionRequested = false
      let autoTurn = false     // 这一轮是 CLI 自己起的,没有用户消息在等回复
      // 接管的代数:排着队的开消息请求发出之后,这一轮可能已经被用户消息接走了,那个请求就作废。
      let adoptGen = 0
      // 后台启动的子代理卡片 → 开它的那一轮的回调。完成通知可能隔了好几轮才到,得回到原来那条消息上。
      const bgCards = new Map<string, ChatCallbacks>()
      // 自己起的那一轮一直不出内容也不出 result:后台没活就回收,有活就再等(墙钟不杀后台任务)。
      let autoWatch: ReturnType<typeof setTimeout> | null = null
      const clearAutoWatch = () => { if (autoWatch) { clearTimeout(autoWatch); autoWatch = null } }
      const armAutoWatch = () => {
        clearAutoWatch()
        autoWatch = setTimeout(() => {
          if (bg.running > 0) { armAutoWatch(); return }
          appLog('info', 'claude', 'chat 回收后台进程 · 自己起的那一轮一直没有输出,后台也没活了')
          stopTree()
        }, CHAT_STALL_KILL_MS)
      }
      let exited: { exitCode?: number } | null = null
      let browserBlocked = false
      let curModel = cliModel(task.model)
      let curPerm = cliPermissionMode(task)
      let ctlSeq = 0
      const pendingCtl = new Map<string, (error: string | null) => void>()
      const sendControl = (id: string, line: string) => new Promise<string | null>((res) => {
        const t = setTimeout(() => { pendingCtl.delete(id); res('timeout') }, CONTROL_REPLY_WAIT_MS)
        pendingCtl.set(id, (e) => { clearTimeout(t); pendingCtl.delete(id); res(e) })
        try { child.stdin?.write(line + '\n') } catch { pendingCtl.get(id)?.('stdin gone') }
      })
      /**
       * 把权限档切到活进程上。★切严失败 = failed:调用方不能拿旧的松档继续干活。
       * 切松失败不致命:实测没带 bypass 启动的进程切 bypassPermissions 回 bypass_not_launched。从自动切是预期
       * (门由 toolConfirm 按会话档放行,效果一样,不用说);从只读切就退到 acceptEdits,否则界面写完全访问、进程还是只读。
       */
      const applyPermission = async (want: string | undefined): Promise<{ failed?: string; note?: string }> => {
        const from = curPerm
        if (!want || want === from) return {}
        const send = (m: string) => { const id = `forge-ctl-${++ctlSeq}`; return sendControl(id, setPermissionModeLine(id, m)) }
        const err = await send(want)
        if (!err) { curPerm = want; return {} }
        appLog('warn', 'claude', `chat 切权限档 ${from} → ${want} 失败:${err}`)
        if ((PERM_RANK[want] ?? 0) < (PERM_RANK[from!] ?? 0)) return { failed: err }
        if (want !== 'bypassPermissions') return { note: `⚠ 没能切到「${permLabel(want)}」，仍按「${permLabel(from!)}」跑。` }
        if (from !== 'plan') return {}
        const fallback = await send('acceptEdits')
        if (fallback) return { note: `⚠ 没能切到「${permLabel(want)}」，仍按「${permLabel(from)}」跑。` }
        curPerm = 'acceptEdits'
        return { note: `⚠ 这个进程切不到「${permLabel(want)}」，先按「${permLabel('acceptEdits')}」跑。` }
      }
      let rawErr = ''            // captured stderr for the no-reply diagnostic
      let errBuf = ''            // stderr line-splitter for live onStatus forwarding
      const makeTurnUsage = () => makeUsageTracker(u => cb.onUsage?.(u))
      let usage = makeTurnUsage()
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
      let subagentIds = new Set<string>()
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
      // 这一轮开始:每一轮自己的状态换新。第一轮和接到活进程上的每一轮都走这里。
      const beginTurn = (nextCb: ChatCallbacks) => {
        turnSeq++
        cb = nextCb
        detached = false
        start = Date.now()
        settled = false
        done = new Promise<AgentResult>((res) => { settle = (r) => { if (settled) return; settled = true; res(r) } })
        sawNotification = false; streamed = false; sawAssistant = false; sawTool = false; turnOk = null; resultError = ''
        rawErr = ''; thinkBuf = ''; needSep = false; autoTurn = false
        subagentIds = new Set<string>()
        usage = makeTurnUsage()
        hooks = makeTurnHooks()
        wd = makeTurnWatchdog()
        if (lingerCap) { clearTimeout(lingerCap); lingerCap = null }
        clearAutoWatch()
        clearLingerKey()
        bg.unpark()
      }
      const sessionFor = (id: string, seq: number, turnDone: Promise<AgentResult>): AgentSession => ({
        id,
        // ★这一轮之后又接了新的一轮:旧句柄不能再杀进程(新的那轮和后台任务都在里面)。
        cancel: () => { if (seq !== turnSeq) return; wd.clear(); hooks.clear(); stopTree() },
        done: turnDone,
      })
      // 下一条消息:写进这个活进程。模型 / 权限档走控制协议现场改;写完 CLI 起一轮,事件照常归这一轮。
      const attach = (next: ChatTask, nextCb: ChatCallbacks, prompt: string, flagsDeferred: boolean): AgentSession => {
        const wasAuto = autoActive
        const held = autoBuf
        autoActive = false; autoBuf = []; adoptionRequested = false
        adoptGen++        // 还排着队的开消息请求作废:那些事件归这一轮了
        if (next.background) background = next.background
        beginTurn(nextCb)
        const seq = turnSeq
        const turnDone = done
        appLog('info', 'claude', `chat 复用活进程发下一条消息 · 后台还有 ${bg.running} 个任务`)
        // spawn 参数变了(浏览器开关 / 代理)但后台还在跑:不杀,这个进程跑完之后新参数才生效。
        if (flagsDeferred) {
          appLog('info', 'claude', 'chat spawn 参数变了但后台任务还在跑:沿用活进程,新参数等它们结束后生效')
          cb.onStatus?.('⚠ 后台任务还在跑，新设置要等它们结束后才生效。')
          if (!next.browserUse || next.browserUse === 'off') browserBlocked = true
        } else browserBlocked = false
        // ★先记下这条消息再回放:攒的事件里可能就有 result,它要负责把消息写出去。
        pendingLine = userMessageLine(prompt)
        holdForAuto = wasAuto
        const wantModel = cliModel(next.model)
        const wantPerm = cliPermissionMode(next)
        const changes: Promise<void>[] = []
        let fatal: string | null = null
        if (wantPerm && wantPerm !== curPerm) {
          changes.push(applyPermission(wantPerm).then((r) => {
            if (r.failed) fatal = `没能切到「${permLabel(wantPerm)}」(${r.failed})，这条消息没有发出。`
            else if (r.note && seq === turnSeq) cb.onStatus?.(r.note)
          }))
        }
        if (wantModel !== curModel) {
          const id = `forge-ctl-${++ctlSeq}`
          changes.push(sendControl(id, setModelLine(id, wantModel)).then((e) => {
            if (!e) { curModel = wantModel; return }
            appLog('warn', 'claude', `chat 切模型到 ${wantModel} 失败:${e}`)
            if (seq === turnSeq) cb.onStatus?.(`⚠ 没能切到模型 ${wantModel}，这条消息仍由 ${curModel} 回答。`)
          }))
        }
        ctlWaiting = changes.length > 0
        for (const obj of held) void handle(obj)
        if (!changes.length) flushPending()
        else void Promise.all(changes).then(() => {
          if (seq !== turnSeq || exited) return
          ctlWaiting = false
          if (!fatal) { flushPending(); return }
          // 这条消息不发、这一轮失败,后台任务不动;已经没活的进程照常回收(再判一次 result)。
          failTurn(fatal)
          bg.result()
        })
        return sessionFor(next.id, seq, turnDone)
      }
      // detach 之后 CLI 自己起的一轮:开一条没有用户消息的回复,把攒的事件回放进去。
      const requestAdoption = () => {
        adoptionRequested = true
        const gen = ++adoptGen
        background!.openTurn((nextCb) => {
          if (gen !== adoptGen) { nextCb.onDone({ elapsed: 0 }); return { id: task.id, cancel: () => {}, done: Promise.resolve({ ok: true }) } }
          adoptionRequested = false
          const held = autoBuf
          autoBuf = []; autoActive = false
          beginTurn(nextCb)
          autoTurn = true
          const seq = turnSeq
          const turnDone = done
          appLog('info', 'claude', 'chat 后台任务完成后 CLI 自己起了一轮,开一条新回复')
          for (const obj of held) void (detached ? handleDetached(obj) : handle(obj))
          // 回放期间进程已经退了(等排队的时候):child.then 那边已经跳过了这一轮,这里补收尾。
          if (exited && !detached) { const r = finishOnExit(exited); wd.clear(); hooks.clear(); settle(r) }
          return sessionFor(task.id, seq, turnDone)
        }, () => gen === adoptGen)
      }
      // 后台子代理要权限:不属于任何一轮,门不跟着哪一轮结束(没有超时,人回来再答),没门才拒。
      const raiseBackgroundGate = async (cut: CanUseTool) => {
        let decision: ConfirmDecision = 'deny'
        if (background?.onConfirm && !(browserBlocked && cut.toolName?.startsWith(BROWSER_TOOL_PREFIX))) {
          const questions = cut.requiresUserInteraction || cut.toolName === 'AskUserQuestion' ? parseAskQuestions(cut.input) : null
          try {
            decision = await background.onConfirm({
              title: questions ? askGateTitle(questions) : gateTitle(cut.toolName),
              where: toolTarget(cut.input), agentId: cut.agentId, toolName: cut.toolName, toolUseId: cut.toolUseId,
              ...(questions ? { questions } : {}),
            })
          } catch { decision = 'deny' }
        }
        if (typeof decision === 'object') respondAnswer(cut, decision.answers ?? {}, decision.response)
        else respond(cut, decision === 'allow')
      }
      const handleDetached = async (obj: any) => {
        const stray = unhandledControlRequest(obj)
        if (stray) { try { child.stdin?.write(controlErrorLine(stray.requestId, `myFlowForge does not support control_request ${stray.subtype}`) + '\n') } catch { /* stdin gone */ } return }
        const cut = parseCanUseTool(obj)
        // 后台子代理的门不属于任何一轮;其余的(主代理、它的前台子代理)是 CLI 自己那一轮卡住了,算开口,跟着那一轮走。
        if (cut && (!background || (cut.agentId && bg.isRunningTask(cut.agentId)))) { await raiseBackgroundGate(cut); return }
        if (!background) { if (obj?.type === 'result') bg.result(); return }
        if (typeof obj?.parent_tool_use_id === 'string') return   // 后台子代理自己的事件,不算主代理开口
        // ★只想不说不算开口:想完返回一个空的成功 result 是常事,为它开一条空消息毫无意义。真开口时想的内容会一起回放。
        const hasContent = !!cut || parseChatStreamActions(obj).some(a => a.kind === 'assistant' || a.kind === 'tool' || a.kind === 'file' || a.kind === 'subagent-start')
        const starts = obj?.type === 'system' && (obj.subtype === 'init' || (obj.subtype === 'status' && obj.status === 'requesting'))
        if (!autoActive && !starts && !hasContent) {
          if (obj?.type === 'result') bg.result()
          return
        }
        autoActive = true
        autoBuf.push(obj)
        if (obj?.type === 'result') {
          if (adoptionRequested) return
          // 报错的 result 要让人看见;一个字都没说的成功一轮不留空气泡,按 result 再判一次要不要留着进程。
          if (obj.is_error === true) { clearAutoWatch(); requestAdoption(); return }
          autoActive = false; autoBuf = []; clearAutoWatch()
          bg.result()
          return
        }
        if (hasContent && !adoptionRequested) { clearAutoWatch(); requestAdoption() }
        else if (!adoptionRequested) armAutoWatch()
      }
      const handle = async (obj: any) => {
        // 钩子事件先过一道:它只影响「现在在等谁」的播报,不参与下面任何解析分支。
        if (hooks.feed(obj)) return
        // 后台子代理真正跑完:它那张卡这时才算完成(启动时的 tool_result 只是回执,见下面 subagent-result)。
        const tn = parseTaskNotification(obj)
        if (tn) sawNotification = true
        if (tn?.toolUseId && subagentIds.has(tn.toolUseId)) cb.onSubagent?.({ id: tn.toolUseId, phase: 'done', result: tn.summary, isError: !tn.ok })
        // ★★同 run():两个调用方都要接 —— 见 [[trap-two-call-sites-run-vs-chat]]。只接一处的话,
        //   工作流那边不挂了、聊天这边照旧是个不动的光标,而聊天才是天天在用的那条。
        const stray = unhandledControlRequest(obj)
        if (stray) {
          try { child.stdin?.write(controlErrorLine(stray.requestId, `myFlowForge does not support control_request ${stray.subtype}`) + '\n') } catch { /* stdin gone */ }
          cb.onStatus?.(`claude 发来一个 Forge 不支持的控制请求(${stray.subtype}),已回复不支持并继续。`)
          return
        }
        const cut = parseCanUseTool(obj)
        if (cut && browserBlocked && cut.toolName?.startsWith(BROWSER_TOOL_PREFIX)) { respond(cut, false); return }
        // ★后台子代理的门:这一轮结束它还得等着,不能挂在这一轮身上被一起收掉。前台子代理的门和主代理的一样卡着这一轮。
        if (cut?.agentId && bg.isRunningTask(cut.agentId) && background?.onConfirm) { await raiseBackgroundGate(cut); return }
        // ★CLI 自己那一轮卡在门上,而用户消息正压着等它结束:用户已经往下说了,拒掉这道门让那一轮收尾,消息才发得出去。
        if (cut && pendingLine && holdForAuto) {
          appLog('info', 'claude', `chat 拒掉 CLI 自己那一轮的门(${cut.toolName}):用户消息在等它结束`)
          respond(cut, false)
          return
        }
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
            // ★★toolUseId 必须带上:上层靠它把「这次是自动放行的」记到**那张工具卡**上。漏掉它,
            //   上层就只能回落成往对话流里插一条「系统 · 回答」消息 —— 长得和模型的回答一模一样,
            //   还夹在工具卡和真正的回答中间(用户原话:「系统回答 不应该出现在这个位置吧」)。
            //   run() 那条路一直是带的,chat() 这条路漏了 —— 而聊天才是天天在看的那条。
            if (cb.onConfirm) decision = await cb.onConfirm({
              title: questions ? askGateTitle(questions) : gateTitle(cut.toolName),
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
        // A sub-agent's OWN internal event: claude tags it with a top-level parent_tool_use_id = the Task
        // tool_use id that spawned it (main-turn events have it null/absent). Attribute the sub-agent's
        // tool calls to that Task's card as live steps — and RETURN so they don't leak into the main
        // turn's 执行 block (the parser is parent-agnostic). Read from the full `assistant` message (full
        // tool input → good titles); the partial stream_event for the same tool is skipped. We only get
        // tool_use/tool_result for sub-agents by default (text/thinking需 --forward-subagent-text).
        const parentId = typeof obj?.parent_tool_use_id === 'string' ? obj.parent_tool_use_id : null
        if (parentId) {
          if (obj.type === 'assistant') {
            // ★只认这一轮开的子代理:上一轮开的后台子代理事件要是也往这里写,会在这条回复里长出一张空卡。
            for (const action of parseChatStreamActions(obj)) {
              if ((action.kind === 'tool' || action.kind === 'file') && subagentIds.has(parentId)) cb.onSubagent?.({ id: parentId, phase: 'update', step: action.text })
            }
          }
          return
        }
        usage.feed(obj)
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
        // ★后台任务还没跑完时 bg 不杀,这一轮照样收尾,进程留在后台(见上面 detach)。
        if (obj?.type === 'result') {
          // 这个 result 是 CLI 自己那一轮的,压着的用户消息现在才写;这一轮(界面上)还没结束。
          if (pendingLine) {
            holdForAuto = false; sawNotification = false
            flushPending()
            return
          }
          if (isReplayedNotificationResult(obj, { sawNotification, sawActivity: sawAssistant || sawTool })) {
            appLog('info', 'claude', 'chat 跳过重放的后台任务通知那一轮的空 result,继续等这条消息的回复')
            return
          }
          turnOk = (obj as { subtype?: string; is_error?: boolean }).subtype === 'success' && (obj as { is_error?: boolean }).is_error !== true
          if (!turnOk && typeof obj.result === 'string') resultError = obj.result.trim()
          // 共商席位:没人看得见也没人停得了,一轮结束连后台任务一起收掉。
          if (task.endWithTurn) { dying = true; bg.clear(); try { killTree(child) } catch { /* already gone */ } return }
          bg.result()
          return
        }
        for (const action of parseChatStreamActions(obj)) {
          if (action.kind === 'session') { untrackLive(); nativeSid = action.id; trackLive(); cb.onSession(action.id) }
          else if (action.kind === 'assistant') {
            flushThink()
            if (needSep) { needSep = false; cb.onAssistantDelta('\n\n') }
            sawAssistant = true; cb.onAssistantDelta(action.text)
          }
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
            // ★后台启动的子代理:这条 tool_result 只是「已启动」回执(还夹着内部 agentId),不是完成 ——
            //   卡片保持运行中,等它的 task_notification(上面)再置完成。
            if (subagentIds.has(action.id) && !action.isError && bg.isBackgroundLaunch(action.id, action.result)) {
              bgCards.set(action.id, cb)
              cb.onSubagent?.({ id: action.id, phase: 'update', step: '已转入后台运行', background: true })
            }
            else if (subagentIds.has(action.id)) cb.onSubagent?.({ id: action.id, phase: 'done', result: action.result, isError: action.isError })
            else cb.onToolActivity?.({ id: action.id, phase: 'done', output: action.result, isError: action.isError })
          }
        }
      }
      // 所有事件的入口:后台任务跟踪和控制回复不分有没有这一轮;其余按「这一轮还在不在」分流。
      const dispatch = async (obj: any) => {
        // ★只有主代理(和它正等着的前台子代理)的动静才算这一轮活着:后台子代理吵个不停时,卡死的这一轮也该报出来。
        const parent = typeof obj?.parent_tool_use_id === 'string' ? obj.parent_tool_use_id : null
        const backgroundNoise = (parent !== null && bg.isBackgroundLaunch(parent))
          || (obj?.type === 'system' && (obj.subtype === 'task_started' || obj.subtype === 'task_progress' || obj.subtype === 'task_updated' || obj.subtype === 'task_notification' || obj.subtype === 'background_tasks_changed'))
        if (!backgroundNoise) wd.beat()
        bg.feed(obj)
        reportRunning(dying ? 0 : bg.running)
        // 后台子代理跑完了:卡片回到开它的那条消息上置完成,不管中间隔了几轮。
        const finished = parseTaskNotification(obj)
        const owner = finished?.toolUseId ? bgCards.get(finished.toolUseId) : undefined
        if (finished?.toolUseId && owner) {
          bgCards.delete(finished.toolUseId)
          subagentIds.delete(finished.toolUseId)
          owner.onSubagent?.({ id: finished.toolUseId, phase: 'done', result: finished.summary, isError: !finished.ok })
        }
        const ctl = parseControlResponse(obj)
        if (ctl) { pendingCtl.get(ctl.requestId)?.(ctl.error); return }
        if (detached) await handleDetached(obj)
        else await handle(obj)
      }
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch { if (!detached) { wd.beat(); sawAssistant = true; cb.onAssistantDelta(line) } return }
        dispatch(obj).catch((err) => { if (detached) logError('claude', 'chat 后台事件处理失败', String(err)); else cb.onError(err instanceof Error ? err : new Error(String(err))) })
      }
      child.stdout?.on('data', (b: Buffer) => {
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
        while ((nl = errBuf.indexOf('\n')) >= 0) { const line = errBuf.slice(0, nl).trim(); errBuf = errBuf.slice(nl + 1); if (line && !isClaudeBenignStderr(line) && !detached) cb.onStatus?.(line) }
      })
      // 进程退出时还开着的那一轮的收尾。
      const finishOnExit = (res: { exitCode?: number }): AgentResult => {
        // 进程没了,压着的用户消息也就发不出去了:必须说出来,不能当作这一轮正常结束。
        if (pendingLine) {
          pendingLine = null
          flushThink()
          if (sawAssistant) cb.onAssistantDelta(`\n\n⚠ ${UNSENT_MESSAGE}`)
          cb.onError(new Error(UNSENT_MESSAGE))
          return { ok: false, summary: UNSENT_MESSAGE }
        }
        flushThink()   // surface any trailing reasoning line that never got a closing newline
        if (errBuf.trim() && !isClaudeBenignStderr(errBuf.trim())) { cb.onStatus?.(errBuf.trim()) } errBuf = ''
        const elapsed = Math.round((Date.now() - start) / 1000)
        // CLI 自己那一轮只想不说、成功结束:什么都没坏,没有要告诉用户的。
        if (autoTurn && turnOk === true && !sawAssistant && !sawTool) {
          cb.onDone({ elapsed })
          return { ok: true, summary: '完成' }
        }
        // No assistant text at all → surface a diagnostic instead of a silent blank bubble (and leave
        // a trail in the debug log, mirroring codex/opencode). Killed-for-silence gets the clearest note.
        if (!sawAssistant && !sawTool) {
          const clip = args.map(a => { const s = String(a); return s.length > 160 ? s.slice(0, 160) + `…(+${s.length - 160})` : s }).join(' ')
          // ★result 明明成功:143 是我们收尾时杀进程杀出来的,不是它的错,不能报成退出码。
          let diag = turnOk === true ? 'claude 这一轮没有返回内容'
            : wd.firedFlag
            ? 'claude 长时间无响应（240s 无任何输出）已终止 —— 可尝试拆分过长的输入或检查网络'
            : resultError ? `claude 报错:${resultError}`
            : rawErr.trim() ? `claude stderr:\n${rawErr.trim()}`
            : res.exitCode === undefined ? 'claude 无输出' : `claude 无输出 (退出码 ${res.exitCode})`
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
      }
      const cleanupOnExit = () => {
        wd.clear(); hooks.clear(); bg.clear(); clearAutoWatch()
        if (lingerCap) clearTimeout(lingerCap)
        clearLingerKey(); untrackLive()
        for (const r of [...pendingCtl.values()]) r('process exited')
        // 进程没了:卡片不能一直转,门也不能挂着等一个已经不在的进程。
        for (const [id, owner] of bgCards) owner.onSubagent?.({ id, phase: 'done', result: '后台进程已结束', isError: true })
        bgCards.clear()
        reportedRunning = 0
        background?.onRunning(0, null)
        background?.onExit?.()
      }
      beginTurn(firstCb)
      trackLive()
      const firstDone = done!
      void child.then((res): AgentResult | null => {
        wd.clear(); hooks.clear()
        processLine(buf); buf = ''
        exited = res
        cleanupOnExit()    // after the final flush: a trailing `result` line must still be judged, but nothing may fire after exit
        // 界面上早已收尾(detach):后台跑完退出,不再往这一轮报任何东西。还排着队要开的那条回复由 requestAdoption 收尾。
        if (detached) { appLog('info', 'claude', `chat 后台进程退出 · 退出码 ${res.exitCode}`); return null }
        return finishOnExit(res)
      }).catch((err): AgentResult | null => {
        exited = { exitCode: undefined }
        cleanupOnExit()
        if (detached) return null
        cb.onError(err as Error); return { ok: false }
      }).then((r) => { if (r) settle(r) })
      return sessionFor(task.id, turnSeq, firstDone)
    }
  }
  // ★同一个会话上一轮留下的活进程:优先把消息写给它(后台任务继续跑)。只有下面两种情况才收掉、再 --resume ——
  //  它已经在被回收;或者 spawn 参数变了而后台已经没活(没东西可丢)。参数变了但后台还在跑时沿用它,新参数之后生效。
  //  收掉时必须等它真退出:两个进程同时写一个会话会互相踩。
  const startChat = provider.chat!.bind(provider)
  provider.chat = (task, cb, env) => {
    const prior = task.sessionId ? lingering.get(lingerKey(task.cwd, task.sessionId)) : undefined
    if (!prior) return startChat(task, cb, env)
    const flagsChanged = prior.signature !== chatSpawnSignature(claudeSpawnArgs(task, env), env)
    if (prior.alive() && (!flagsChanged || prior.running() > 0)) return prior.attach(task, cb, claudeChatPrompt(task, env), flagsChanged)
    appLog('info', 'claude', `chat 收掉旧进程后 --resume · ${flagsChanged ? 'spawn 参数变了且后台没活' : '旧进程已在回收'}`)
    let inner: AgentSession | null = null
    let cancelled = false
    const done = prior.stop().then(() => {
      if (cancelled) { cb.onError(new Error('已停止')); return { ok: false } }
      inner = startChat(task, cb, env)
      return inner.done
    })
    return { id: task.id, cancel: () => { cancelled = true; inner?.cancel() }, done }
  }
  provider.setChatPermission = (cwd, sessionId, mode) => liveChats.get(lingerKey(cwd, sessionId))?.setPermission(mode) ?? Promise.resolve(null)
  return provider
}
