import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { acpProviderChat, type AcpProviderChatSpec } from '../acp/acpProvider'
import type { PermissionMode } from '@shared/permissions'
import { createFenceScanner } from '../handoffFence'
import { provisionForgeMcp } from '../forgeMcpProvision'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface GeminiSpec { bin?: string; preArgs?: string[]; defaultModels: Model[]; acp?: AcpProviderChatSpec['acp'] }

/**
 * ACP 聊天的启动参数。★`--approval-mode default` 显式钉死:用户自己的 settings.json 里可能把默认档设成了
 *  yolo/auto_edit,那样工具就不经 session/request_permission 直接跑了 —— Forge 的门(以及「完全访问」的
 *  自动放行)必须是唯一的决定者。「只读审阅」档映射成 `plan`(`--help`:read-only mode),和 claude 的 plan 同理。
 */
export function geminiAcpArgs(model: string, mode?: PermissionMode): string[] {
  return ['--acp', '--approval-mode', mode === 'readonly' ? 'plan' : 'default', ...(model && model !== 'default' ? ['-m', model] : [])]
}

export function makeGeminiProvider(spec: GeminiSpec): AgentProvider {
  const bin = spec.bin ?? 'gemini'
  const defaultModels: Model[] = spec.defaultModels ?? []
  const provider: AgentProvider = {
    id: 'gemini',
    displayName: 'Gemini CLI',
    bin,
    capabilities: { structuredOutput: false, permissionHook: true, pty: false, mcpTools: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      // chat() goes through ACP; when the CLI can't speak ACP it falls back to driving a real turn through run()
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
      const child: ResultPromise = spawnAgent(bin, args, { cwd: task.cwd, env, reject: false })
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
      return { id: task.agentId, cancel: () => killTree(child), done }
    }
  }
  // 聊天走 ACP(`gemini --acp`):真流式 + 逐操作确认门;握手不成透明回落到上面的 run()。
  // ★forge MCP 由 session/new 的 mcpServers 带过去,所以这条路**不**写 .gemini/settings.json。
  provider.chat = acpProviderChat({ bin, args: (t) => geminiAcpArgs(t.model, t.permissionMode), run: (t, c, e) => provider.run(t, c, e), acp: spec.acp })
  return provider
}
