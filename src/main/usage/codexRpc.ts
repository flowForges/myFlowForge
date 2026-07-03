import { spawn as nodeSpawn } from 'node:child_process'
import type { StatusbarUsage, UsageWindow } from './types'

// Minimal child-process surface so tests can fake the app-server end to end.
export interface RpcChild {
  stdin: { write(s: string): void }
  stdout: { on(ev: 'data', cb: (c: Buffer) => void): void }
  stderr: { on(ev: 'data', cb: (c: Buffer) => void): void }
  on(ev: 'error' | 'close', cb: (arg?: unknown) => void): void
  kill(): void
}

export interface RpcDeps {
  spawn?: (cmd: string, args: string[]) => RpcChild
  timeoutMs?: number
}

type RpcWindow = { usedPercent?: number; resetsAt?: number }

function mapWindow(w: RpcWindow | undefined): UsageWindow | undefined {
  if (typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return undefined
  const resetAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : undefined
  return { used: Math.round(w.usedPercent), limit: 100, ...(resetAt !== undefined ? { resetAt } : {}) }
}

// Ask the local Codex CLI for its own rate-limit windows over JSON-RPC
// (`codex app-server`, the same data source the CLI statusbar renders), instead
// of scraping the reverse-engineered chatgpt.com backend. Read-only + untrusted
// sandbox flags keep the probe side-effect free. The server follows the LSP
// handshake: initialize → initialized notification → regular requests.
export function fetchCodexUsageViaRpc(deps: RpcDeps = {}): Promise<StatusbarUsage> {
  const spawn = deps.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
  const timeoutMs = deps.timeoutMs ?? 10_000
  return new Promise<StatusbarUsage>((resolve, reject) => {
    const child = spawn('codex', ['-s', 'read-only', '-a', 'untrusted', 'app-server'])
    let buffer = ''
    let settled = false
    let rpcId = 0
    let readId: number | null = null

    const timer = setTimeout(() => fail(new Error('Codex app-server RPC 超时')), timeoutMs)
    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      fn()
    }
    function fail(err: Error): void { settle(() => reject(err)) }

    function send(method: string, params?: unknown, id?: number): void {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params: params ?? {} })}\n`)
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    }

    const initId = ++rpcId

    // Listeners must be attached before the first write: a fast (or fake)
    // server may answer synchronously.
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          msg = JSON.parse(line) as typeof msg
        } catch {
          continue // startup banner or other non-JSON noise
        }
        if (msg.id == null) continue // server-initiated notification
        if (msg.id === initId) {
          send('initialized')
          readId = ++rpcId
          send('account/rateLimits/read', undefined, readId)
          continue
        }
        if (readId !== null && msg.id === readId) {
          if (msg.error) return fail(new Error(msg.error.message ?? 'Codex app-server RPC 出错'))
          const rl = (msg.result as { rateLimits?: { primary?: RpcWindow; secondary?: RpcWindow } } | undefined)?.rateLimits
          const window5h = mapWindow(rl?.primary)
          const weekly = mapWindow(rl?.secondary)
          if (!window5h && !weekly) return fail(new Error('Codex app-server 未返回额度窗口'))
          return settle(() => resolve({
            ...(window5h ? { window5h } : {}),
            ...(weekly ? { weekly } : {}),
            label: 'Codex',
          }))
        }
      }
    })
    child.stderr.on('data', () => {}) // drain so the child never blocks on a full pipe
    child.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    child.on('close', () => fail(new Error('Codex app-server 提前退出')))

    send('initialize', { clientInfo: { name: 'myFlowForge', version: '1.0.0' } }, initId)
  })
}
