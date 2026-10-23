import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { createFenceScanner } from '../handoffFence'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface TraeSpec { bin?: string; defaultModels: Model[] }

// ★只读:plan 模式(只分析不改代码,ExitPlanMode 本身要审批,无头下出不来)+ 把会写 / 跑命令 / 定时的工具
//  全部 --disallowed-tool(先于一切规则检查,bypass 也盖不过,裸工具名直接从模型的工具表里移除)。无头下没被
//  授权的工具「自动跳过」,不会挂起。依据 research.md §9(traecli 0.120.51 `traecli doc ...`),未真机探针。
const TRAE_READONLY_ARGS = ['--permission-mode', 'plan',
  ...['Edit', 'Write', 'ApplyPatch', 'Bash', 'KillShell', 'CronCreate', 'CronDelete'].flatMap(t => ['--disallowed-tool', t])]

// TraeCode CLI (字节跳动 Trae, binary `traecli`, 通过 install.sh 安装到 ~/.local/bin,非 npm 包)。无头:
// `traecli -p "<prompt>"` 跑一轮并把回复以纯文本流到 stdout(每行 IS 输出 → 'accent',被 chat 降级捕获)。
// 模型:没有 --model,但 `-c model.name=<m>` 能逐次覆盖配置(名字须在 trae_cli.yaml 的 models: 里),选了具体模型
// 才传。print 模式的工具授权由 trae_cli.yaml 的 permission_mode 决定(想无人值守写文件设 bypass_permissions),
// app 不代改其配置 —— 只读档除外,见 run() 里的 TRAE_READONLY_ARGS。
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
      const args = ['-p', prompt]
      if (task.permissionMode === 'readonly') args.push(...TRAE_READONLY_ARGS)
      if (task.model && task.model !== 'default') args.push('-c', `model.name=${task.model}`)
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
