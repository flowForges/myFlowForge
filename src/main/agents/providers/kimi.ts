import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { createFenceScanner } from '../handoffFence'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface KimiSpec { bin?: string; defaultModels: Model[] }

// Kimi Code CLI (MoonshotAI/kimi-code, npm @moonshot-ai/kimi-code, binary `kimi`) — the new TypeScript
// agent, NOT the legacy Python `kimi-cli`. Headless: `kimi -p "<prompt>" --output-format text` runs one
// turn and streams the assistant's reply to stdout (every line IS assistant output → 'accent', captured
// by the chat downgrade). Print mode implicitly enables --afk, auto-approving all tool calls, so no
// permission/sandbox flags are needed for a non-interactive run. `--model` selects a model; omitting it
// uses kimi's account default. No native chat()/resume wired yet → chat uses the run-downgrade.
export function makeKimiProvider(spec: KimiSpec): AgentProvider {
  const bin = spec.bin ?? 'kimi'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'kimi',
    displayName: 'Kimi Code',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: false },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const directive = forgeChatDirective(env)
      const prompt = directive ? `${directive}\n\n${task.prompt}` : task.prompt
      const args = ['-p', prompt, '--output-format', 'text']
      if (task.model && task.model !== 'default') args.push('--model', task.model)
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      let buf = ''
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        for (const out of scanner.feedLine(line)) {
          cb.onLog({ ts: now(), text: out, level: 'accent' })
        }
      }
      child.stdout?.on('data', (b: Buffer) => {
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          processLine(line)
        }
      })
      const done = child.then((res) => {
        processLine(buf); buf = '' // flush any final line with no trailing newline
        for (const out of scanner.flush()) {
          cb.onLog({ ts: now(), text: out, level: 'accent' })
        }
        const ok = res.exitCode === 0
        cb.onState(ok ? 'ok' : 'err')
        const result = { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
        cb.onDone(result); return result
      }).catch((err) => { cb.onState('err'); cb.onError(err as Error); return { ok: false } })
      return { id: task.agentId, cancel: () => child.kill('SIGTERM'), done }
    }
  }
}
