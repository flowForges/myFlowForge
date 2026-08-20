import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { createFenceScanner } from '../handoffFence'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface TraeSpec { bin?: string; defaultModels: Model[] }

// TraeCode CLI (字节跳动 Trae, binary `traecli`, 通过 install.sh 安装到 ~/.local/bin,非 npm 包)。无头:
// `traecli -p "<prompt>"` 跑一轮并把回复以纯文本流到 stdout(每行 IS 输出 → 'accent',被 chat 降级捕获)。
// 模型无 CLI 开关(用 /model 命令或 trae_cli.yaml 配置),故这里不传 --model,只给「账号默认」。print 模式的工具
// 授权由 trae_cli.yaml 的 permission_mode 决定(想无人值守写文件设 bypass_permissions),app 不代改其配置。
// 无原生 chat()/resume → chat 走 run 降级(回灌本地历史)。
export function makeTraeProvider(spec: TraeSpec): AgentProvider {
  const bin = spec.bin ?? 'traecli'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'trae',
    displayName: 'Trae',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: false },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const directive = forgeChatDirective(env)
      const prompt = directive ? `${directive}\n\n${task.prompt}` : task.prompt
      // No --model: traecli picks the model from /model or trae_cli.yaml, not the command line.
      const args = ['-p', prompt]
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
