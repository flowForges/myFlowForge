import { describe, it, expect } from 'vitest'
import { fetchCodexUsageViaRpc, type RpcChild } from './codexRpc'

// Fake `codex app-server` child that speaks newline-delimited JSON-RPC.
// Responses are driven by what the client writes to stdin, so tests verify
// the real handshake order (initialize → initialized → account/rateLimits/read).
class FakeChild implements RpcChild {
  written: string[] = []
  killed = false
  private cbs: Record<string, ((arg?: unknown) => void)[]> = {}
  constructor(private onWrite?: (line: string, child: FakeChild) => void) {}
  stdin = {
    write: (s: string): void => {
      this.written.push(s)
      this.onWrite?.(s, this)
    },
  }
  stdout = { on: (_ev: 'data', cb: (c: Buffer) => void): void => { this.push('stdout', cb as (arg?: unknown) => void) } }
  stderr = { on: (_ev: 'data', cb: (c: Buffer) => void): void => { this.push('stderr', cb as (arg?: unknown) => void) } }
  on(ev: 'error' | 'close', cb: (arg?: unknown) => void): void { this.push(ev, cb) }
  kill(): void { this.killed = true }
  private push(ev: string, cb: (arg?: unknown) => void): void { (this.cbs[ev] ??= []).push(cb) }
  emit(ev: string, arg?: unknown): void { for (const cb of this.cbs[ev] ?? []) cb(arg) }
  emitStdout(text: string): void { this.emit('stdout', Buffer.from(text)) }
}

// Scripted happy-path server: answers initialize, then rate limits.
function scriptedServer(rateLimitsResult: unknown): (line: string, child: FakeChild) => void {
  return (line, child) => {
    const msg = JSON.parse(line) as { id?: number; method?: string }
    if (msg.method === 'initialize') {
      child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
    } else if (msg.method === 'account/rateLimits/read') {
      child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: rateLimitsResult })}\n`)
    }
  }
}

const HAPPY_RESULT = {
  rateLimits: {
    primary: { usedPercent: 31.4, windowDurationMins: 300, resetsAt: 1_782_740_133 },
    secondary: { usedPercent: 45, windowDurationMins: 10_080, resetsAt: 1_783_000_000 },
  },
}

describe('fetchCodexUsageViaRpc', () => {
  it('spawns codex app-server read-only and maps primary/secondary to 5h/weekly', async () => {
    let spawned: { cmd: string; args: string[] } | null = null
    let child: FakeChild
    const usage = await fetchCodexUsageViaRpc({
      spawn: (cmd, args) => {
        spawned = { cmd, args }
        child = new FakeChild(scriptedServer(HAPPY_RESULT))
        return child
      },
    })
    expect(spawned).toEqual({ cmd: 'codex', args: ['-s', 'read-only', '-a', 'untrusted', 'app-server'] })
    expect(usage.window5h).toEqual({ used: 31, limit: 100, resetAt: 1_782_740_133_000 })
    expect(usage.weekly).toEqual({ used: 45, limit: 100, resetAt: 1_783_000_000_000 })
    expect(usage.label).toBe('Codex')
    expect(child!.killed).toBe(true)
  })

  it('sends the initialized notification between initialize and the read request', async () => {
    let child: FakeChild
    await fetchCodexUsageViaRpc({
      spawn: () => { child = new FakeChild(scriptedServer(HAPPY_RESULT)); return child },
    })
    const methods = child!.written.map((l) => (JSON.parse(l) as { method: string }).method)
    expect(methods).toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
    // The notification must carry no id, or the server treats it as a request.
    const initialized = JSON.parse(child!.written[1]) as Record<string, unknown>
    expect(initialized.id).toBeUndefined()
  })

  it('ignores non-JSON lines and server notifications without id', async () => {
    const usage = await fetchCodexUsageViaRpc({
      spawn: () => new FakeChild((line, child) => {
        const msg = JSON.parse(line) as { id?: number; method?: string }
        if (msg.method === 'initialize') {
          child.emitStdout('codex app-server booting…\n')
          child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} })}\n`)
          child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
        } else if (msg.method === 'account/rateLimits/read') {
          child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: HAPPY_RESULT })}\n`)
        }
      }),
    })
    expect(usage.window5h?.used).toBe(31)
  })

  it('tolerates windows without resetsAt', async () => {
    const usage = await fetchCodexUsageViaRpc({
      spawn: () => new FakeChild(scriptedServer({ rateLimits: { primary: { usedPercent: 7 } } })),
    })
    expect(usage.window5h).toEqual({ used: 7, limit: 100 })
    expect(usage.weekly).toBeUndefined()
  })

  it('rejects when the server returns an RPC error', async () => {
    await expect(fetchCodexUsageViaRpc({
      spawn: () => new FakeChild((line, child) => {
        const msg = JSON.parse(line) as { id?: number; method?: string }
        if (msg.method === 'initialize') {
          child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
        } else if (msg.method === 'account/rateLimits/read') {
          child.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'not logged in' } })}\n`)
        }
      }),
    })).rejects.toThrow(/not logged in/)
  })

  it('rejects when both windows are missing (caller should fall back)', async () => {
    await expect(fetchCodexUsageViaRpc({
      spawn: () => new FakeChild(scriptedServer({ rateLimits: {} })),
    })).rejects.toThrow()
  })

  it('rejects when the codex binary is missing (spawn error)', async () => {
    const child = new FakeChild()
    const p = fetchCodexUsageViaRpc({ spawn: () => child })
    child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }))
    await expect(p).rejects.toThrow(/ENOENT/)
  })

  it('rejects when the process exits before answering', async () => {
    const child = new FakeChild()
    const p = fetchCodexUsageViaRpc({ spawn: () => child })
    child.emit('close')
    await expect(p).rejects.toThrow(/退出|exit/i)
  })

  it('rejects on timeout and kills the child', async () => {
    const child = new FakeChild()
    const p = fetchCodexUsageViaRpc({ spawn: () => child, timeoutMs: 15 })
    await expect(p).rejects.toThrow(/超时|timeout/i)
    expect(child.killed).toBe(true)
  })
})
