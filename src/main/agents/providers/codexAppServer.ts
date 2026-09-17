import { spawnAgent, killTree } from '../procGroup'
import { adaptCodexEvent, codexTokenUsage } from './codexEventAdapter'
import { codexApprovalResponse, elicitationUnsupported, PERMISSIONS_METHOD, ELICITATION_METHOD } from './codexApproval'

// Minimal child-process surface so tests can fake the app-server end to end.
export interface CodexChild {
  stdin: { write(s: string): void }
  stdout: { on(ev: 'data', cb: (c: Buffer) => void): void }
  stderr: { on(ev: 'data', cb: (c: Buffer) => void): void }
  on(ev: 'error' | 'close', cb: (arg?: unknown) => void): void
  kill(): void
}

export interface CodexAppServerDeps {
  spawn?: (cmd: string, args: string[]) => CodexChild
}

export interface CodexTurnOpts {
  cwd: string
  prompt: string
  modelArgs: string[]
  configArgs: string[]
  sandbox: string
  approvalPolicy: string
  resumeThreadId?: string
}

/**
 * 一次审批请求。`itemId` 是**这次调用自己那条 item 的 id** —— 和 `item/started` / `item/completed`
 * 里 `item.id` 是同一个值,也就是对话区那张工具卡的行 id。
 *
 * ★★它必须一路带到确认门上:上层只有拿得到它,才能把「已按完全访问自动放行」记到**那张卡**上;
 *  拿不到就只能回落成往对话流里插一条系统消息,而那条消息的正文是原样的 shell 命令 —— 用户看到的
 *  就是「bash 的内容出现在了 LLM 输出的地方」。见 codex.chat.gate.test.ts。
 *
 * v2 那三个 `item/…/requestApproval` 都把 itemId 列为 required(codex-cli 0.153.4 的 JSON schema
 * 亲口给的);只有 v1 的 execCommandApproval/applyPatchApproval 老方法没有,所以这里是可选的。
 */
export interface CodexApprovalReq {
  method: string; command?: string; paths?: string[]; itemId?: string
  /** `item/permissions/requestApproval`:要申请的权限档 + 为什么。 */
  permissions?: unknown; reason?: string
  /** `mcpServer/elicitation/request`:哪个 MCP 在问、问什么、用哪种形态问。 */
  serverName?: string; message?: string; mode?: string; url?: string
  requestedSchema?: { required?: string[] | null; properties?: Record<string, unknown> }
  /**
   * codex 对这条命令的**尽力解析**(官方 schema 的 `CommandAction`:`read` | `listFiles` |
   * `search` | `unknown`)。用来判断「这次是不是纯读」——见 codexApproval.ts 的 `codexReadOnly`。
   * ★老版本 codex 不发这个字段,所以它可能是 undefined,判断必须**失败即拦**。
   */
  commandActions?: unknown[]
}

export interface CodexTurnCallbacks {
  onEvent(execShaped: any): void // feed to the shared codex handler (parseCodexEvent/…)
  onApproval(req: CodexApprovalReq): Promise<'allow' | 'deny'>
  onSession(threadId: string): void
  onError(message: string): void
  /**
   * 一句给用户看的提示(不是错误,不终止这一轮)。
   *
   * ★★用来兜「codex 问了一件我们答不上来的事」。这种情况原来是**静默**的 —— 用户看到的是
   *  一个一直在动、永远没有内容的光标,而且不知道是卡住了还是在想。宁可说一句「有人在问、
   *  我替你拒了」,也不能什么都不说。
   */
  onNotice?(text: string): void
  /**
   * 上下文用量。★codex 是唯一一个**已用和窗口都官方上报**的 provider,所以只有它能给出
   * 可信的占比 —— 别处的窗口要么靠 CLI 报、要么就没有。
   */
  onUsage?(u: { used: number; window?: number }): void
}

export interface CodexTurnHandle {
  cancel(): void
  done: Promise<{ ok: boolean }>
}

/**
 * codex 会**向我们发起、并等着我们回答**的请求里,能映射成一道「允许 / 拒绝」的那些。
 *
 * ★★每一条的回答形状都不一样(见 codexApproval.ts 的 codexApprovalResponse)。形状错了不会报错,
 *  只会让 codex 反序列化失败、那次调用永远悬着 —— 表现成「光标一直在动但没有内容」。
 */
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  PERMISSIONS_METHOD,
  ELICITATION_METHOD,
  'execCommandApproval',
  'applyPatchApproval',
])

/**
 * codex 还会发的、但我们目前**答不上来**的请求。列在这儿是为了能对它们说一句人话 ——
 * 而不是像以前那样统统回一个 `{}`。
 *
 * ★`requestUserInput` 的回答 schema 是 `{answers: {…}}`(answers 必填),所以可以回一个空表:
 *  语义是「一个问题都没答」,codex 能继续跑。其余的我们连形状都不知道,只能按 JSON-RPC 规矩
 *  回「没有这个方法」,让 codex 自己决定怎么办。
 */
const KNOWN_UNANSWERABLE: Record<string, { what: string; reply?: unknown }> = {
  requestUserInput: { what: 'codex 想问你几个问题', reply: { answers: {} } },
  'item/tool/call': { what: 'codex 想让 Forge 执行一个客户端工具' },
  'account/chatgptAuthTokens/refresh': { what: 'codex 想刷新 ChatGPT 登录令牌' },
  'attestation/generate': { what: 'codex 想生成一份客户端证明' },
}

// Drives one Codex `app-server` turn over newline-delimited JSON-RPC: handshake
// (initialize → initialized → thread/start|resume) → turn/start, then streams
// server notifications back as exec-shaped events (via adaptCodexEvent) and
// routes approval server-requests through cb.onApproval. Mirrors the framing
// skeleton in usage/codexRpc.ts and adds the thread/turn drive on top.
export function driveCodexTurn(opts: CodexTurnOpts, cb: CodexTurnCallbacks, deps: CodexAppServerDeps = {}): CodexTurnHandle {
  // ★ 必须走 spawnAgent(execa),不能用 node 原生 spawn:Windows 上 codex 是 npm 装的 `codex.cmd` 包装,
  // 原生 spawn 拿裸名会直接 ENOENT(2026-08-22 真机实测:execFileSync/spawnSync 都失败,execa 成功)。
  // execa 内部走 cross-spawn,会解析 .cmd 并正确转义参数。spawnAgent 顺带给了进程组语义 + 退出兜底登记,
  // 和这里原来手写的 agentSpawnOptions()+trackAgentChild 完全等价。
  // reject:false —— 我们从不 await 这个 promise(只用它的 stdio 流),非零退出不该变成未处理的 rejection。
  const spawn = deps.spawn ?? ((cmd, args) => spawnAgent(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, reject: false }) as unknown as CodexChild)
  const args = [...opts.configArgs, ...opts.modelArgs, 'app-server']
  const child = spawn('codex', args)

  let buffer = ''
  let settled = false
  let rpcId = 0
  let threadId: string | undefined
  let resolveDone!: (v: { ok: boolean }) => void
  const done = new Promise<{ ok: boolean }>((resolve) => { resolveDone = resolve })

  function settle(ok: boolean): void {
    if (settled) return
    settled = true
    killTree(child)   // 杀整棵树:app-server 也会派生 shell 命令,单杀只会留孤儿
    resolveDone({ ok })
  }

  // A stray notification/error arriving after the turn already settled (success
  // or failure) must not surface a spurious error to the caller.
  function safeError(message: string): void {
    if (!settled) cb.onError(message)
  }

  function send(method: string, params?: unknown, id?: number): void {
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params: params ?? {} })}\n`)
    } catch (e) {
      // A send from cancel()'s `turn/interrupt` fires AFTER the turn already settled+killed the
      // child, so its stdin is dead by then — that's an expected post-settle write failure, not a
      // real error. safeError() (unlike a bare cb.onError) no-ops once `settled`, matching respond().
      safeError(e instanceof Error ? e.message : String(e))
      settle(false)
    }
  }

  function respond(id: number, result: unknown): void {
    if (settled) return // the child is already killed; writing now would hit a dead stdin
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
    } catch {
      // best-effort; a broken pipe here will also trip the child's error/close listeners
    }
  }

  /**
   * 按 JSON-RPC 规矩回一个错误。★这是「我们不支持这个请求」的**正确**说法 ——
   * 回一个猜出来的 result 只会让对面反序列化失败然后永远等下去,而错误码它一定看得懂。
   */
  function respondError(id: number, code: number, message: string): void {
    if (settled) return
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
    } catch {
      // best-effort，同 respond()
    }
  }

  const initId = ++rpcId
  let startId: number | null = null
  let turnId: number | null = null

  // Listeners must be attached before the first write: a fast (or fake) server
  // may answer synchronously.
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number; method?: string; params?: any; result?: any; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue // startup banner or other non-JSON noise
      }

      // Server request: has both an id and a method.
      if (msg.id != null && msg.method) {
        const id = msg.id
        const method = msg.method
        if (APPROVAL_METHODS.has(method)) {
          const params = msg.params ?? {}
          const req: CodexApprovalReq = {
            method, command: params.command, paths: params.paths,
            itemId: typeof params.itemId === 'string' && params.itemId ? params.itemId : undefined,
            permissions: params.permissions, reason: params.reason,
            serverName: params.serverName, message: params.message, mode: params.mode,
            url: params.url, requestedSchema: params.requestedSchema,
            // ★codex 自己解析好的动作标签(read/listFiles/search/unknown)。只读判断**只能**靠它,
            //  不许我们去猜命令字符串 —— 见 codexApproval.ts 的 codexReadOnly。
            commandActions: params.commandActions,
          }
          // ★要填表单的那种 elicitation 我们渲染不出来。但**绝不能因此就不回答** ——
          //  那正是「光标一直在动、永远没有内容」的成因。说清缺什么、替他拒掉、让这一轮跑完。
          const cantAnswer = elicitationUnsupported(req)
          if (cantAnswer) {
            cb.onNotice?.(`MCP「${req.serverName ?? '未知服务'}」要你填一张表单(${cantAnswer}),Forge 还不支持 MCP 表单,已代你拒绝并继续。`)
            respond(id, codexApprovalResponse(method, false, req))
            continue
          }
          void cb.onApproval(req)
            .then((decision) => {
              respond(id, codexApprovalResponse(method, decision === 'allow', req))
            })
            .catch((e) => {
              // Fail closed: the server is blocked awaiting this response, so a
              // rejected approval callback (e.g. the confirm gate was torn down)
              // must still be answered — otherwise `done` hangs forever. Let the
              // decline flow to turn/completed naturally rather than force-settling.
              respond(id, codexApprovalResponse(method, false, req))
              safeError(e instanceof Error ? e.message : String(e))
            })
        } else {
          // ★★这里原来是一句 `respond(id, {})` —— 对**任何**不认识的请求回一个空对象,还一声不吭。
          //  空对象几乎一定缺必填字段,于是 codex 反序列化失败、那次调用永远悬着,而用户什么也看不到。
          //  现在:能答的按 schema 答一个「什么都没给」的合法回答,答不了的按 JSON-RPC 规矩报
          //  「没有这个方法」——两种都**说一句人话**,让用户知道刚才有人问过、以及被怎么处理了。
          const known = KNOWN_UNANSWERABLE[method]
          cb.onNotice?.(known
            ? `${known.what},Forge 还答不了这种请求,已跳过并继续。`
            : `codex 发来一个 Forge 不认识的请求(${method}),已按「不支持」回复并继续。`)
          if (known?.reply !== undefined) respond(id, known.reply)
          else respondError(id, -32601, `myFlowForge does not implement ${method}`)
        }
        continue
      }

      // Notification: has a method, no id.
      if (msg.id == null && msg.method) {
        const method = msg.method
        const params = msg.params ?? {}
        if (method === 'turn/completed') {
          settle(true)
          continue
        }
        if (method === 'error') {
          const m = params.error && typeof params.error === 'object' ? params.error.message : (params.message ?? params.error)
          safeError(String(m ?? 'codex error'))
          settle(false)
          continue
        }
        if (method === 'thread/status/changed' && params?.status?.type === 'systemError') {
          const m = params.status.message ?? params.status.error ?? 'codex system error'
          safeError(String(m))
          settle(false)
          continue
        }
        // 上下文用量:官方数,直接透出去(adaptCodexEvent 不认这条,以前就这么被丢掉了)。
        const u = codexTokenUsage(msg)
        if (u) { cb.onUsage?.(u); continue }
        const e = adaptCodexEvent(msg)
        if (e) cb.onEvent(e)
        continue
      }

      // Response to one of our own requests, routed by id.
      if (msg.id === initId) {
        if (msg.error) {
          safeError(msg.error.message ?? 'codex initialize 失败')
          settle(false)
          continue
        }
        send('initialized')
        if (opts.resumeThreadId) {
          startId = ++rpcId
          send('thread/resume', { threadId: opts.resumeThreadId }, startId)
        } else {
          startId = ++rpcId
          send('thread/start', { approvalPolicy: opts.approvalPolicy, sandbox: opts.sandbox, cwd: opts.cwd }, startId)
        }
        continue
      }
      if (startId !== null && msg.id === startId) {
        if (msg.error) {
          safeError(msg.error.message ?? 'codex thread/start 失败')
          settle(false)
          continue
        }
        threadId = msg.result?.thread?.id ?? msg.result?.threadId ?? opts.resumeThreadId
        if (threadId) cb.onSession(threadId)
        turnId = ++rpcId
        send('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt }] }, turnId)
        continue
      }
      if (turnId !== null && msg.id === turnId) {
        // turn/start's result is ignored; the turn itself runs via notifications.
        if (msg.error) {
          safeError(msg.error.message ?? 'codex turn/start 失败')
          settle(false)
        }
        continue
      }
    }
  })
  child.stderr.on('data', () => {}) // drain so the child never blocks on a full pipe
  child.on('error', (err) => {
    // Actionable hint: this fires for an ASYNC spawn failure (e.g. codex missing, or an old
    // codex build that doesn't understand the `app-server` subcommand) — the caller-side
    // synchronous try/catch around driveCodexTurn() cannot catch this (the handle already
    // returned), so the message itself needs to point at the likely cause.
    const m = err instanceof Error ? err.message : String(err)
    safeError(`codex app-server 启动失败(是否已安装/支持 app-server?): ${m}`)
    settle(false)
  })
  child.on('close', () => settle(false))

  send('initialize', { clientInfo: { name: 'myFlowForge', version: '1.0.0' } }, initId)

  return {
    cancel(): void {
      send('turn/interrupt', { threadId })
      settle(false) // kills the child (see settle())
    },
    done,
  }
}
