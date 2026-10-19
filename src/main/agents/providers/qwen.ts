import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { acpProviderChat, type AcpProviderChatSpec } from '../acp/acpProvider'
import { createFenceScanner } from '../handoffFence'
import { provisionForgeMcp } from '../forgeMcpProvision'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface QwenSpec { bin?: string; defaultModels: Model[]; acp?: AcpProviderChatSpec['acp'] }

/**
 * ACP 聊天的启动参数(qwen 0.24.7 `--help` 核过:`--acp`、`--approval-mode` 都有)。
 * ★`--approval-mode default` 显式钉死,理由同 gemini:用户配置里的 yolo/auto-edit/auto 会让工具绕过
 *  session/request_permission,Forge 的门必须是唯一的决定者。
 */
export function qwenAcpArgs(model: string): string[] {
  return ['--acp', '--approval-mode', 'default', ...(model && model !== 'default' ? ['-m', model] : [])]
}

// Qwen Code (阿里) is a fork of gemini-cli for Qwen3-Coder — its non-interactive invocation mirrors
// gemini's: `qwen -m <model> -p <prompt>` prints the model's reply to stdout. So this adapter is the
// gemini one-shot adapter with id/bin swapped. Chat goes through ACP (`qwen --acp`), falling back to
// this run() when the CLI can't speak ACP — same as gemini.
export function makeQwenProvider(spec: QwenSpec): AgentProvider {
  const bin = spec.bin ?? 'qwen'
  const defaultModels: Model[] = spec.defaultModels ?? []
  const provider: AgentProvider = {
    id: 'qwen',
    displayName: 'Qwen Code',
    bin,
    capabilities: { structuredOutput: false, permissionHook: true, pty: false, mcpTools: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      // chat() goes through ACP; when the CLI can't speak ACP it falls back to driving a real turn through run()
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
  // 聊天走 ACP;forge MCP 由 session/new 带过去,这条路不写 .qwen/settings.json。
  provider.chat = acpProviderChat({ bin, args: (t) => qwenAcpArgs(t.model), run: (t, c, e) => provider.run(t, c, e), acp: spec.acp })
  return provider
}
