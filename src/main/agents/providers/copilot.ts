import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { createFenceScanner } from '../handoffFence'
import { provisionForgeMcp } from '../forgeMcpProvision'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface CopilotSpec { bin?: string; defaultModels: Model[] }

// The NEW agentic GitHub Copilot CLI (`copilot`, npm @github/copilot) — NOT `gh copilot suggest`.
// Non-interactive: `copilot -p "<prompt>" --allow-all-tools` runs one agent turn and prints the
// result to stdout; --allow-all-tools skips the per-tool approval prompts that would otherwise hang
// a headless run. Model is selected with --model when the user picked one other than 账号默认.
// Flags follow the public-preview CLI; if a future version renames them, override the bin/args via a
// custom agent. No chat()/resume yet → chat mode uses the run-downgrade (surfaces accent logs).
export function makeCopilotProvider(spec: CopilotSpec): AgentProvider {
  const bin = spec.bin ?? 'copilot'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      // No chat()/resume yet → the chat downgrade (chatService.ts) drives a real turn through run()
      // with an AgentTask built from the live prompt. forgeChatDirective fails open (returns '' when
      // env.FORGE_TOOLS lacks forge_propose_plan, i.e. workflow-stage/delegate sub-agent runs), so
      // prepending it here unconditionally only adds the dual-path instructions for chat turns.
      const directive = forgeChatDirective(env)
      const prompt = directive ? `${directive}\n\n${task.prompt}` : task.prompt
      const prov = provisionForgeMcp('copilot', env, task.cwd)
      // prov already includes --allow-all-tools when forge is injected; avoid a duplicate flag by
      // falling back to it only when nothing was injected.
      const args = ['-p', prompt, ...(prov.extraArgs.length ? prov.extraArgs : ['--allow-all-tools'])]
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
