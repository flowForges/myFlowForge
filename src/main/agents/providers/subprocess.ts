import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { createFenceScanner } from '../handoffFence'

export interface SubprocessSpec {
  id: string
  displayName: string
  bin: string
  buildArgs: (task: AgentTask) => string[]
  models: Model[]
}

function now() { return new Date().toISOString().slice(11, 19) }

// Emits complete lines from a chunked stream, holding any incomplete tail until the next chunk
// (a single logical line can arrive split across two 'data' events). Returns a flush() for stream end.
function lineEmitter(emit: (text: string) => void): { feed(b: Buffer): void; flush(): void } {
  let buf = ''
  return {
    feed(b) {
      buf += b.toString()
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const line of parts) { const t = line.trimEnd(); if (t) emit(t) }
    },
    flush() { const t = buf.trimEnd(); if (t) emit(t); buf = '' }
  }
}

export function makeSubprocessProvider(spec: SubprocessSpec): AgentProvider {
  return {
    id: spec.id,
    displayName: spec.displayName,
    bin: spec.bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    async detect() {
      try { await execa(spec.bin, ['--version']); return true } catch { return false }
    },
    async listModels() { return spec.models },
    // `done` resolves with the same AgentResult that is also delivered via cb.onDone — callers
    // should use one or the other (onDone for reactive UI, done for orchestrator sequencing).
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      // Scan stdout for forge:handoff fences like every other text-fallback provider — otherwise a
      // custom agent assigned to a workflow stage silently drops its handoff (upstream context/design
      // docs never reach downstream stages or the review gate).
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const child: ResultPromise = execa(spec.bin, spec.buildArgs(task), { cwd: task.cwd, env, reject: false })
      const log = (text: string) => cb.onLog({ ts: now(), text, level: 'info' })
      const outEmitter = lineEmitter(line => { for (const out of scanner.feedLine(line)) log(out) })
      const errEmitter = lineEmitter(log)
      child.stdout?.on('data', (b: Buffer) => outEmitter.feed(b))
      child.stderr?.on('data', (b: Buffer) => errEmitter.feed(b))
      const done = child.then((res) => {
        outEmitter.flush(); errEmitter.flush()
        for (const out of scanner.flush()) log(out)   // release any unclosed-fence lines verbatim
        const ok = res.exitCode === 0
        const cancelled = res.isTerminated === true || res.signal != null
        cb.onState(ok ? 'ok' : 'err')
        const summary = ok ? '完成' : cancelled ? '已取消' : `退出码 ${res.exitCode}`
        const result = { ok, summary }
        cb.onDone(result)
        return result
      }).catch((err) => {
        cb.onState('err'); cb.onError(err as Error); return { ok: false, summary: String(err) }
      })
      return { id: task.agentId, cancel: () => child.kill('SIGTERM'), done }
    }
  }
}
