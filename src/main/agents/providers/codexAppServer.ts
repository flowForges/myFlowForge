import { spawn as nodeSpawn } from 'node:child_process'
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
  const spawn = deps.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
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
    resolveDone({ ok })
  }

  function send(method: string, params?: unknown, id?: number): void {
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params: params ?? {} })}\n`)
    } catch (e) {
      cb.onError(e instanceof Error ? e.message : String(e))
      settle(false)
    }
  }

  function respond(id: number, result: unknown): void {
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
          void cb.onApproval(req).then((decision) => {
            respond(id, { decision: codexDecision(method, decision === 'allow') })
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
          cb.onError(String(m ?? 'codex error'))
          settle(false)
          continue
        }
        if (method === 'thread/status/changed' && params?.status?.type === 'systemError') {
          const m = params.status.message ?? params.status.error ?? 'codex system error'
          cb.onError(String(m))
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
          cb.onError(msg.error.message ?? 'codex initialize 失败')
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
          cb.onError(msg.error.message ?? 'codex thread/start 失败')
          settle(false)
          continue
        }
        threadId = msg.result?.thread?.id ?? msg.result?.threadId
        if (threadId) cb.onSession(threadId)
        turnId = ++rpcId
        send('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt }] }, turnId)
        continue
      }
      if (turnId !== null && msg.id === turnId) {
        // turn/start's result is ignored; the turn itself runs via notifications.
        if (msg.error) {
          cb.onError(msg.error.message ?? 'codex turn/start 失败')
          settle(false)
        }
        continue
      }
    }
  })
  child.stderr.on('data', () => {}) // drain so the child never blocks on a full pipe
  child.on('error', (err) => {
    cb.onError(err instanceof Error ? err.message : String(err))
    settle(false)
  })
  child.on('close', () => settle(false))

  send('initialize', { clientInfo: { name: 'myFlowForge', version: '1.0.0' } }, initId)

  return {
    cancel(): void {
      send('turn/interrupt', { threadId })
      child.kill()
      settle(false)
    },
    done,
  }
}
