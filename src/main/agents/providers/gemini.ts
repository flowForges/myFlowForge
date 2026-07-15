import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { createFenceScanner } from '../handoffFence'
import { provisionForgeMcp } from '../forgeMcpProvision'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface GeminiSpec { bin?: string; preArgs?: string[]; defaultModels: Model[] }

export function makeGeminiProvider(spec: GeminiSpec): AgentProvider {
  const bin = spec.bin ?? 'gemini'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'gemini',
    displayName: 'Gemini CLI',
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
      const prov = provisionForgeMcp('gemini', env, task.cwd)
      if (prov.gitignoreHint) {
        cb.onLog({ ts: now(), text: `已为 gemini 写入 ${prov.gitignoreHint}，建议加入 .gitignore`, level: 'info' })
      }
      const args = spec.preArgs
        ? [...spec.preArgs]
        : ['-m', task.model, '-p', prompt, ...prov.extraArgs]
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      let buf = ''
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        for (const out of scanner.feedLine(line)) {
          // `gemini -p` prints the model's reply to stdout, so every line IS assistant
          // output → 'accent'. This also lets the chat downgrade (which surfaces only
          // accent/ok logs) capture gemini replies when used as a chat-less provider.
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
