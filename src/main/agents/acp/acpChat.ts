import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification, type Stream } from '@agentclientprotocol/sdk'
import { spawnAgent, killTree } from '../procGroup'
import { makeIdleWatchdog, CHAT_IDLE_MS, CHAT_STALL_KILL_MS } from '../idleWatchdog'
import { buildChatPrompt } from '../chatStream'
import { forgeServerSpec } from '../mcpConfig'
import { forgeChatDirective } from '../forgeChatDirective'
import { confirmAllowed, type AgentResult, type AgentSession, type ChatCallbacks, type ChatTask } from '../types'
import { acpKnownUnavailable, recordAcpHandshake } from './acpAvailability'
import { acpGateReq, forgeAcpMcpServers, mergeToolState, permissionResponse, toolOutputText, CANCELLED_PERMISSION, type AcpToolState } from './acpMap'

// ── 通用 ACP(Agent Client Protocol v1)聊天客户端 ─────────────────────────────────────────
//
// 给「只有 run()」的 provider(gemini / qwen / copilot / kimi …)一条真正的 chat 路:起 `<bin> <args>`
// (args 里带 provider 自己的 ACP 开关),stdio 上跑 ndjson JSON-RPC,把 session/update 映射到 ChatCallbacks。
//
// ★★和 provider 的接法:provider 调 `runAcpChat` / `chatWithAcpFallback`。握手没成(起不来、不认 --acp、
//  initialize 报错、超时、协议版本不对)抛的是 `AcpUnavailableError` —— 这是「回落到老的 run() 聊天」的
//  信号,不是给用户看的错误。握手之后的任何失败都是普通错误,不回落:那时可能已经流出过正文、
//  甚至执行过工具,再用另一条路重跑一遍这一轮是错的。

export interface AcpSpec { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }

/** 「这个 agent 讲不了 ACP」—— 调用方据此回落到 run() 聊天。 */
export class AcpUnavailableError extends Error {
  readonly acpUnavailable = true
  constructor(message: string) { super(message); this.name = 'AcpUnavailableError' }
}
export function isAcpUnavailable(e: unknown): e is AcpUnavailableError {
  return e instanceof AcpUnavailableError || (!!e && typeof e === 'object' && (e as { acpUnavailable?: unknown }).acpUnavailable === true)
}

/** 一条到 agent 的连接。默认实现是起子进程;测试里换成内存流上的假 agent。 */
export interface AcpTransport {
  stream: Stream
  kill(): void
  /** 进程没了(正常退出、被杀、或者压根没起来)。 */
  exited: Promise<{ code?: number | null; message?: string }>
}

export interface AcpChatOptions {
  open?: (spec: AcpSpec, onStderr: (chunk: string) => void) => AcpTransport
  /** 给了就由它接回落信号(并且**不再**走 cb.onError);没给就把 AcpUnavailableError 交给 cb.onError。 */
  onUnavailable?: (err: AcpUnavailableError) => void
  /** 握手成功(initialize 回来、协议版本对)。 */
  onHandshake?: () => void
  /** 握手(起进程 → initialize 回来)最长等多久。 */
  handshakeMs?: number
  /** 取消时 session/cancel 发出去之后,最多等多久再杀进程树。 */
  cancelGraceMs?: number
}

/**
 * ★30s:CLI 冷启动(node 包 + 读配置 + 连 MCP)在慢机器上要十几秒。不认 `--acp` 的老版本有两种表现:
 *  报错退出(秒回落),或者把 stdin 当 prompt 一直等 —— 后者只能靠这个超时兜住。
 */
export const ACP_HANDSHAKE_MS = 30_000
const CANCEL_GRACE_MS = 500
/** 进程退出后,等在途响应落地的上限。 */
const EXIT_DRAIN_MS = 300
const STDERR_TAIL = 2000

/** 起 agent 进程,把 stdio 接成 ACP 流。走 spawnAgent:进程组 + 退出兜底 + Windows .cmd 解析都在那里。 */
export function spawnAcpTransport(spec: AcpSpec, onStderr: (chunk: string) => void): AcpTransport {
  // buffer:false —— 一个会话的 stdout 可能跑上几个小时,execa 默认会把它整段攒进结果对象里。
  const child = spawnAgent(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], buffer: false, windowsHide: true, reject: false })
  // 进程死后再往 stdin 写会 EPIPE;没人监听的 'error' 事件会把主进程带走。
  child.stdin?.on('error', () => {})
  child.stderr?.on('data', (b: Buffer) => onStderr(b.toString()))
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  )
  const exited = child.then(
    (r) => ({ code: r.exitCode ?? null, message: r.failed && r.exitCode === undefined ? r.shortMessage : undefined }),
    (e: unknown) => ({ code: null, message: e instanceof Error ? e.message : String(e) }),
  )
  return { stream, kill: () => killTree(child), exited }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  return String(e)
}

/** 跑一轮 ACP 聊天。返回的 AgentSession 和别的 provider 的 chat() 一样用。 */
export function runAcpChat(spec: AcpSpec, task: ChatTask, cb: ChatCallbacks, opts: AcpChatOptions = {}): AgentSession {
  const start = Date.now()
  const elapsed = () => Math.round((Date.now() - start) / 1000)
  let resolveDone!: (r: AgentResult) => void
  const done = new Promise<AgentResult>((r) => { resolveDone = r })

  let settled = false
  let handshaken = false
  let sessionId: string | null = null
  /** 这一轮的 session/prompt 落地(不论成败)。取消时等它,好让 agent 有机会自己收尾。 */
  let promptInFlight: Promise<void> | null = null
  let transport: AcpTransport | null = null
  let conn: ClientConnection | null = null
  let stderrTail = ''
  // 悬着的权限请求:取消 / 收尾时统一按 cancelled 回答(协议要求:取消后必须回答所有待决的权限请求)。
  let releaseGates!: () => void
  const gatesReleased = new Promise<void>((r) => { releaseGates = r })

  // 回复的分段:工具调用之后、或者换了一条消息,正文另起一段,别和前一句粘在一起。
  let deliveredText = false
  let breakBeforeText = false
  let lastMessageId: string | null = null
  const tools = new Map<string, AcpToolState>()
  const toolsDone = new Set<string>()
  let lastUsage = ''

  const wd = makeIdleWatchdog(CHAT_IDLE_MS,
    () => cb.onStatus?.(`⏳ 已经 ${Math.round(CHAT_IDLE_MS / 1000)}s 没有任何输出。可能在等一个 Forge 看不见的确认（外部钩子 / 浏览器授权 / sudo）。要停就点上面的停止。`),
    undefined,
    { hardMs: CHAT_STALL_KILL_MS, onDeadline: () => { cb.onStatus?.('⚠ 太久没有任何输出，已回收这一轮。'); cancel() } })

  const kill = () => { try { conn?.close() } catch { /* 已关 */ } try { transport?.kill() } catch { /* 已死 */ } }

  function settle(): boolean {
    if (settled) return false
    settled = true
    wd.clear()
    releaseGates()
    return true
  }
  function finishOk(): void {
    if (!settle()) return
    kill()
    cb.onDone({ elapsed: elapsed() })
    resolveDone({ ok: true, summary: '完成' })
  }
  function finishError(e: unknown): void {
    if (!settle()) return
    kill()
    cb.onError(e instanceof Error ? e : new Error(errMessage(e)))
    resolveDone({ ok: false, summary: errMessage(e) })
  }
  function finishUnavailable(reason: string): void {
    if (!settle()) return
    kill()
    const tail = stderrTail.trim()
    const err = new AcpUnavailableError(tail ? `${reason}\n${tail}` : reason)
    if (opts.onUnavailable) opts.onUnavailable(err)
    else cb.onError(err)
    resolveDone({ ok: false, summary: err.message })
  }

  function cancel(): void {
    if (!settle()) return
    const sid = sessionId
    const c = conn
    // ★先礼后兵:session/cancel 让 agent 自己收尾(停掉在跑的工具、回 stopReason:cancelled),
    //  悬着的权限请求已经由 settle() 按 cancelled 答掉。等这一轮的 prompt 落地就杀整棵进程树兜底;
    //  agent 不理睬 / 管道卡住也不能让「停止」失效,所以最多等 grace 就动手。
    if (sid && c) {
      const grace = new Promise<void>((r) => setTimeout(r, opts.cancelGraceMs ?? CANCEL_GRACE_MS))
      const landed = c.agent.notify('session/cancel', { sessionId: sid }).then(() => promptInFlight, () => {}).catch(() => {})
      void Promise.race([landed, grace]).then(kill)
    } else kill()
    cb.onDone({ elapsed: elapsed() })
    resolveDone({ ok: false, summary: '已取消' })
  }

  function onStderr(chunk: string): void {
    if (settled) return
    wd.beat()
    // 握手前的 stderr 只攒着:真回落时它是排查线索,不回落时它是不认 --acp 的报错,不该先闪给用户。
    if (!handshaken) { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL); return }
    for (const line of chunk.split('\n')) { const t = line.trim(); if (t) cb.onStatus?.(t) }
  }

  function emitText(text: string, messageId: string | null | undefined): void {
    if (messageId && lastMessageId && messageId !== lastMessageId) breakBeforeText = true
    if (messageId) lastMessageId = messageId
    cb.onAssistantDelta(deliveredText && breakBeforeText ? `\n\n${text}` : text)
    deliveredText = true
    breakBeforeText = false
  }

  function onUpdate(n: SessionNotification): void {
    // ★只认当前会话。session/load 时 agent 会把历史整段重放 —— 那时 sessionId 还没赋值,自然被挡在外面。
    if (settled || !sessionId || n.sessionId !== sessionId) return
    wd.beat()
    cb.onActivity?.()
    const u = n.update
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text' && u.content.text) emitText(u.content.text, u.messageId)
        return
      case 'agent_thought_chunk':
        if (u.content.type === 'text' && u.content.text) cb.onThinkDelta(u.content.text)
        return
      case 'tool_call':
      case 'tool_call_update': {
        const id = u.toolCallId
        const known = tools.has(id)
        const t = mergeToolState(tools.get(id), u)
        tools.set(id, t)
        breakBeforeText = true
        const title = t.title || t.name || undefined
        const name = t.name ?? t.kind ?? undefined
        if (u.sessionUpdate === 'tool_call' || !known || u.title) cb.onToolActivity?.({ id, phase: 'start', name, title })
        if ((u.status === 'completed' || u.status === 'failed') && !toolsDone.has(id)) {
          toolsDone.add(id)
          cb.onToolActivity?.({ id, phase: 'done', name, title, output: toolOutputText(t.content, t.rawOutput), isError: u.status === 'failed' })
        }
        return
      }
      case 'usage_update': {
        const key = `${u.used}/${u.size}`
        if (key === lastUsage) return
        lastUsage = key
        cb.onUsage?.({ used: u.used, window: u.size > 0 ? u.size : undefined })
        return
      }
      default:
        return   // plan / 可用命令 / 模式切换 等:现有回调里没有对应的落点
    }
  }

  async function onPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (settled || p.sessionId !== sessionId) return CANCELLED_PERMISSION
    const id = p.toolCall.toolCallId
    const t = mergeToolState(tools.get(id), p.toolCall)
    tools.set(id, t)
    // ★没有确认门 = 失败即拦,和 codex 那条路一样:无人值守时绝不替用户放行。
    //  「完全访问」的自动放行在上层 toolConfirm 里按会话**当前**权限档做,这里不重复判断。
    if (!cb.onConfirm) return permissionResponse(p.options, false)
    wd.pause()
    try {
      const decided = cb.onConfirm(acpGateReq(id, t)).then((d) => permissionResponse(p.options, confirmAllowed(d) === 'allow'))
      return await Promise.race([decided, gatesReleased.then(() => CANCELLED_PERMISSION)])
    } catch {
      return permissionResponse(p.options, false)
    } finally {
      wd.resume()
    }
  }

  async function drive(): Promise<void> {
    const c = conn!
    // ── 握手:这一段里的任何失败都是「讲不了 ACP」→ 回落 ──
    let loadSession = false
    const handshakeMs = opts.handshakeMs ?? ACP_HANDSHAKE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`ACP 握手超时(${Math.round(handshakeMs / 1000)}s)`)), handshakeMs) })
      const init = await Promise.race([
        c.agent.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          // ★不提供 fs / terminal:让 agent 自己读写文件、自己跑命令 —— 和它在 run() 里的行为一致,
          //  权限也只经过 session/request_permission 这一道门。
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'myFlowForge', version: '1.0.0' },
        }),
        timeout,
      ])
      if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`ACP 协议版本不匹配:agent 回 ${init.protocolVersion},我们只讲 ${PROTOCOL_VERSION}`)
      loadSession = !!init.agentCapabilities?.loadSession
    } catch (e) {
      finishUnavailable(`ACP 握手失败: ${errMessage(e)}`)
      return
    } finally {
      clearTimeout(timer)
    }
    if (settled) return
    handshaken = true
    opts.onHandshake?.()
    // 进程讲得了 ACP 了 —— 这就是「活着」:调用方(比如上下文总结)等的是第一个活着的信号才挂占位。
    cb.onActivity?.()
    if (stderrTail.trim()) for (const line of stderrTail.split('\n')) { const t = line.trim(); if (t) cb.onStatus?.(t) }
    stderrTail = ''

    // ── 会话 + 这一轮 ──
    try {
      const mcpServers = forgeAcpMcpServers(forgeServerSpec(spec.env))
      let sid: string | null = null
      if (task.sessionId && loadSession) {
        try {
          await c.agent.request('session/load', { sessionId: task.sessionId, cwd: task.cwd, mcpServers })
          sid = task.sessionId
        } catch (e) {
          if (settled) return
          cb.onStatus?.(`无法续接上一次的会话(${errMessage(e)}),已新开一个会话。`)
        }
      }
      if (settled) return
      if (!sid) sid = (await c.agent.request('session/new', { cwd: task.cwd, mcpServers })).sessionId
      if (settled) return
      sessionId = sid
      cb.onSession(sid)

      const directive = forgeChatDirective(spec.env)
      const body = buildChatPrompt(task)
      const text = directive ? `${directive}\n\n${body}` : body
      const prompt = c.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] })
      promptInFlight = prompt.then(() => {}, () => {})
      const res = await prompt
      if (settled) return
      if (res.usage) cb.onTurnTokens?.({ input: res.usage.inputTokens, output: res.usage.outputTokens })
      finishOk()
    } catch (e) {
      finishError(e)
    }
  }

  try {
    transport = (opts.open ?? spawnAcpTransport)(spec, onStderr)
    conn = client({ name: 'myFlowForge' })
      .onNotification('session/update', (ctx) => { onUpdate(ctx.params) })
      .onRequest('session/request_permission', (ctx) => onPermission(ctx.params))
      .connect(transport.stream)
  } catch (e) {
    finishUnavailable(`ACP agent 起不来: ${errMessage(e)}`)
    return { id: task.id, cancel, done }
  }
  void transport.exited.then(async (r) => {
    if (settled) return
    // ★答完就退的 agent:最后那条 session/prompt 响应可能还在管道里没解析完,退出信号就先到了。
    //  握手之后先给在途的那一轮一个落地的机会(落地了 drive 自己会正常收尾),等不到才算中途退出。
    if (handshaken) {
      let drain: ReturnType<typeof setTimeout> | undefined
      await Promise.race([promptInFlight ?? new Promise<void>(() => {}), new Promise<void>((res) => { drain = setTimeout(res, EXIT_DRAIN_MS) })])
      clearTimeout(drain)
    }
    if (settled) return
    const why = r.message ?? `退出码 ${r.code ?? '?'}`
    if (!handshaken) finishUnavailable(`ACP agent 在握手前退出了(${why})`)
    else finishError(new Error(`ACP agent 中途退出了(${why})`))
  })
  void drive()
  return { id: task.id, cancel, done }
}

/**
 * 回落到 run() 之前的那道关(见 ChatTask.beforeFallback):
 *  - 没给 hook → 不回落,按「没有 chat()」失败(AcpUnavailableError 交给 cb.onError),调用方走它老的那条路;
 *  - hook 答 false → 不跑,这一轮按「停止」收尾(cb.onDone,和 cancel 一样);拒绝的那句话由 hook 自己说;
 *  - 等 hook 的时候被取消 → 同样按停止收尾,hook 后来答什么都不跑。
 */
export function guardedFallback(task: ChatTask, cb: ChatCallbacks, fallback: () => AgentSession, reason = 'ACP 不可用'): AgentSession {
  const ask = task.beforeFallback
  if (!ask) {
    const err = new AcpUnavailableError(`${reason}(这次调用不回落到 run())`)
    cb.onError(err)
    return { id: task.id, cancel: () => {}, done: Promise.resolve({ ok: false, summary: err.message }) }
  }
  const start = Date.now()
  const stop = () => cb.onDone({ elapsed: Math.round((Date.now() - start) / 1000) })
  let current: AgentSession | null = null
  let cancelled = false
  const done = (async (): Promise<AgentResult> => {
    let allowed = false
    try { allowed = await ask() } catch { allowed = false }
    if (cancelled) return { ok: false, summary: '已取消' }
    if (!allowed) { stop(); return { ok: false, summary: '未授权回落到 run()' } }
    try { current = fallback() } catch (e) {
      cb.onError(e instanceof Error ? e : new Error(errMessage(e)))
      return { ok: false, summary: errMessage(e) }
    }
    return current.done.catch((e: unknown) => ({ ok: false, summary: errMessage(e) }))
  })()
  return {
    id: task.id,
    cancel: () => {
      if (current) { current.cancel(); return }
      if (cancelled) return
      cancelled = true
      stop()
    },
    done,
  }
}

/**
 * ACP 优先,讲不了就回落到 `fallback()`(provider 老的 run() 聊天)。返回的会话在两条路之间透明:
 * cancel 打到当前那条,done 来自最终跑完的那条。
 *
 * ★回落只发生在握手阶段,那时还一个字都没流给用户,所以换路不会出现半截重复的回答。
 * ★握手结果按 `spec.bin` 记下来(acpAvailability.ts):本次运行里已知讲不了 ACP 的 bin 直接走回落,不再试。
 * ★★回落一律经 guardedFallback:run() 那条路没有门,没人点头就不跑(见 ChatTask.beforeFallback)。
 */
export function chatWithAcpFallback(spec: AcpSpec, task: ChatTask, cb: ChatCallbacks, fallback: () => AgentSession, opts: Omit<AcpChatOptions, 'onUnavailable'> & { onFallback?: (err: AcpUnavailableError) => void } = {}): AgentSession {
  let resolveDone!: (r: AgentResult) => void
  const done = new Promise<AgentResult>((r) => { resolveDone = r })
  let current: AgentSession | null = null
  let fellBack = false
  if (acpKnownUnavailable(spec.bin)) return guardedFallback(task, cb, fallback, `${spec.bin} 讲不了 ACP`)
  const acp = runAcpChat(spec, task, cb, {
    ...opts,
    onHandshake: () => { recordAcpHandshake(spec.bin, true); opts.onHandshake?.() },
    onUnavailable: (err) => {
      fellBack = true
      recordAcpHandshake(spec.bin, false)
      opts.onFallback?.(err)
      current = guardedFallback(task, cb, fallback, err.message)
      current.done.then(resolveDone, (e) => resolveDone({ ok: false, summary: errMessage(e) }))
    },
  })
  if (!fellBack) current = acp
  void acp.done.then((r) => { if (!fellBack) resolveDone(r) })
  return { id: task.id, cancel: () => { current?.cancel() }, done }
}
