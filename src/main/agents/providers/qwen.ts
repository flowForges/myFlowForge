import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { createFenceScanner } from '../handoffFence'
import { provisionForgeMcp } from '../forgeMcpProvision'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface QwenSpec { bin?: string; defaultModels: Model[] }

// Qwen Code (阿里) is a fork of gemini-cli for Qwen3-Coder — its non-interactive invocation mirrors
// gemini's: `qwen -m <model> -p <prompt>` prints the model's reply to stdout. So this adapter is the
// gemini one-shot adapter with id/bin swapped. No chat()/resume yet → chat mode uses the run-downgrade
// (surfaces accent logs), same as gemini.
export function makeQwenProvider(spec: QwenSpec): AgentProvider {
  const bin = spec.bin ?? 'qwen'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'qwen',
    displayName: 'Qwen Code',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      // No chat()/resume yet → the chat downgrade (chatService.ts) drives a real turn through run()
      // with an AgentTask built from the live prompt. forgeChatDirective fails open (returns '' when
      // env.FORGE_TOOLS lacks forge_propose_plan), so prepending it here unconditionally only adds
      // the dual-path instructions for chat turns.
      const directive = forgeChatDirective(env)
      const prompt = directive ? `${directive}\n\n${task.prompt}` : task.prompt
      const prov = provisionForgeMcp('qwen', env, task.cwd)
      if (prov.gitignoreHint) {
        cb.onLog({ ts: now(), text: `已为 qwen 写入 ${prov.gitignoreHint}，建议加入 .gitignore`, level: 'info' })
      }
      const args = ['-m', task.model, '-p', prompt, ...prov.extraArgs]
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
