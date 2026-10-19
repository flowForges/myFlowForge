import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { acpProviderChat, type AcpProviderChatSpec } from '../acp/acpProvider'
import { createFenceScanner } from '../handoffFence'
import { provisionForgeMcp } from '../forgeMcpProvision'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface CopilotSpec { bin?: string; defaultModels: Model[]; acp?: AcpProviderChatSpec['acp'] }

/**
 * ACP 聊天的启动参数(copilot 1.0.70 `--help`:`--acp`)。
 * ★**不带** `--allow-all-tools` / `--allow-all` / `--yolo`:带了工具就不再经 session/request_permission 问,
 *  门形同虚设。run() 那条无头路才需要它(没人能回答 TUI 里的确认)。
 */
export function copilotAcpArgs(model: string): string[] {
  return ['--acp', ...(model && model !== 'default' ? ['--model', model] : [])]
}

/** ★`COPILOT_ALLOW_ALL` 等价于 `--allow-all-tools`(见 `copilot --help`)—— 用户 shell 里设了它,ACP 这条路的门就被绕过了。 */
export function copilotAcpEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete env.COPILOT_ALLOW_ALL
  return env
}

// The NEW agentic GitHub Copilot CLI (`copilot`, npm @github/copilot) — NOT `gh copilot suggest`.
// Non-interactive: `copilot -p "<prompt>" --allow-all-tools` runs one agent turn and prints the
// result to stdout; --allow-all-tools skips the per-tool approval prompts that would otherwise hang
// a headless run. Model is selected with --model when the user picked one other than 账号默认.
// Flags follow the public-preview CLI; if a future version renames them, override the bin/args via a
// custom agent. Chat goes through ACP (`copilot --acp`), falling back to this run() when the CLI can't
// speak ACP.
export function makeCopilotProvider(spec: CopilotSpec): AgentProvider {
  const bin = spec.bin ?? 'copilot'
  const defaultModels: Model[] = spec.defaultModels ?? []
  const provider: AgentProvider = {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
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
      const prov = provisionForgeMcp('copilot', env, task.cwd)
      // prov already includes --allow-all-tools when forge is injected; avoid a duplicate flag by
      // falling back to it only when nothing was injected.
      const args = ['-p', prompt, ...(prov.extraArgs.length ? prov.extraArgs : ['--allow-all-tools'])]
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
  // 聊天走 ACP;forge MCP 由 session/new 带过去,这条路不拼 --additional-mcp-config。
  provider.chat = acpProviderChat({ bin, args: (t) => copilotAcpArgs(t.model), env: copilotAcpEnv, run: (t, c, e) => provider.run(t, c, e), acp: spec.acp })
  return provider
}
