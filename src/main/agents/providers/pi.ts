import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { createFenceScanner } from '../handoffFence'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface PiSpec { bin?: string; defaultModels: Model[] }

// pi (earendil-works/pi, npm @earendil-works/pi-coding-agent) — a multi-provider coding agent.
// Headless: `pi -p "<prompt>"` runs one turn in --mode text (default) and prints the model's reply to
// stdout, so every stdout line IS assistant output (captured as 'accent' → the chat downgrade surfaces
// it). `--model provider/id` selects a model; omitting it uses pi's configured default provider. pi has
// no MCP and no permission popups in print mode, so no forge tools / sandbox flags are wired (mcpTools:
// false). No native chat()/resume yet → chat uses the run-downgrade (re-feeds local history).
export function makePiProvider(spec: PiSpec): AgentProvider {
  const bin = spec.bin ?? 'pi'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'pi',
    displayName: 'Pi',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: false },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const directive = forgeChatDirective(env)
      const prompt = directive ? `${directive}\n\n${task.prompt}` : task.prompt
      const args = ['-p', prompt]
      if (task.model && task.model !== 'default') args.push('--model', task.model)
      const child: ResultPromise = spawnAgent(bin, args, { cwd: task.cwd, env, reject: false })
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
      return { id: task.agentId, cancel: () => killTree(child), done }
    }
  }
}
