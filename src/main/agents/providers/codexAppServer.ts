import { spawnAgent, killTree } from '../procGroup'
import { adaptCodexEvent } from './codexEventAdapter'
import { codexDecision } from './codexApproval'

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

export interface CodexTurnCallbacks {
  onEvent(execShaped: any): void // feed to the shared codex handler (parseCodexEvent/…)
  onApproval(req: { method: string; command?: string; paths?: string[] }): Promise<'allow' | 'deny'>
  onSession(threadId: string): void
  onError(message: string): void
}

export interface CodexTurnHandle {
  cancel(): void
  done: Promise<{ ok: boolean }>
}

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
])

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
          const req = { method, command: params.command, paths: params.paths }
          void cb.onApproval(req)
            .then((decision) => {
              respond(id, { decision: codexDecision(method, decision === 'allow') })
            })
            .catch((e) => {
              // Fail closed: the server is blocked awaiting this response, so a
              // rejected approval callback (e.g. the confirm gate was torn down)
              // must still be answered — otherwise `done` hangs forever. Let the
              // decline flow to turn/completed naturally rather than force-settling.
              respond(id, { decision: codexDecision(method, false) })
              safeError(e instanceof Error ? e.message : String(e))
            })
        } else {
          respond(id, {})
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
