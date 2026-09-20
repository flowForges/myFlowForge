import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import type { PermissionMode } from '@shared/permissions'
import { createFenceScanner } from '../handoffFence'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

export interface DeepseekSpec { bin?: string; defaultModels: Model[] }

/**
 * DeepSeek Harness（`@deepseek-ai/dsh`，二进制 `dsh`）。
 *
 * ★它跟已接的另外 13 个都不一样:**不是「一个 headless 开关」,而是按 profile 选运行形态** ——
 *  `headless` 跑一轮就退,`acp` 在 stdio 上说 Agent Client Protocol,`sdk` 说它自家的 JSON-RPC,
 *  `web` 起 127.0.0.1:3080 网页版。这里接的是 `headless`(第一轮),ACP 那条留给 dshAcp.ts。
 *
 * 无头:`dsh --profile headless -- -- "<prompt>"`。
 *
 * ★★那两个 `--` 不是手滑(2026-09-09 本机实测 0.1.2-rc.1):launcher 自己吃掉一个 `--`,
 *  剩下那个才是给 headless app 的 commander 的。少一个,任何**以 `-` 开头的 prompt**都会被
 *  当成未知选项直接拒掉(`error: unknown option '--weird prompt'`),而模型的正文里出现
 *  `--foo` 开头是很常见的。加上之后两种 prompt 都能过到真实请求那一步。
 *
 * ★★它 headless 下 **stdout 全程静默,只在最后吐一坨最终回复**(推理增量走 stderr)。
 *  所以:① stdout 和 stderr 的任何字节都要报 `onActivity`,否则一轮长思考在 UI 上就是「死了」;
 *  ② **不许挂空闲看门狗** —— 帮助里明说「一次没有推理的成功回答会让 stderr 全空」,
 *   挂了就会把一次正常的长思考误杀。进程自己退出就是唯一的收尾信号。
 *
 * ★headless 的 `--help` 里**一个选项都没有**(实测):没有 `--model`、没有 `--resume`、
 *  没有 `--output-format`。所以模型只有「账号默认」一条,chat 也只能走 run 降级(回灌本地历史)。
 *
 * 权限档走**环境变量**而不是命令行 flag(所以不进 permissionArgs.ts)。三档在它的 composed
 * config 里是现成的(`dsh --profile headless --dump-default-config` 第 110/124 行):
 *   read-only / workspace-write / danger-full-access
 * 其中只有 `danger-full-access` 会把审批策略降成 `never`;另外两档是 `ask`,而 headless 没挂
 * 任何审批应答器 —— 它自己的说法是 “without an available answerer, the request fails closed”,
 * 也就是**直接拒绝、不会挂死**。这正是我们要的语义,不用像 codex 那样另外钉死 approval_policy。
 */
export function makeDeepseekProvider(spec: DeepseekSpec): AgentProvider {
  const bin = spec.bin ?? 'dsh'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'deepseek',
    displayName: 'DeepSeek',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: false },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const directive = forgeChatDirective(env)
      const prompt = directive ? `${directive}\n\n${task.prompt}` : task.prompt
      // 见文件头:两个 `--` 缺一不可。prompt 作为**一个** argv 元素传(headless 会把多个词按空格拼回去)。
      const args = ['--profile', 'headless', '--', '--', prompt]
      const child: ResultPromise = spawnAgent(bin, args, {
        cwd: task.cwd,
        env: { ...env, DSH_PERMISSION_MODE: dshPermissionMode(task.permissionMode) },
        reject: false,
      })

      // stdout：最终回复。整段都是助手正文 → 'accent'（和 kimi/trae 一样被 chat 降级捕获）。
      let out = ''
      const processOut = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        for (const text of scanner.feedLine(line)) cb.onLog({ ts: now(), text, level: 'accent' })
      }
      child.stdout?.on('data', (b: Buffer) => {
        cb.onActivity?.()
        out += b.toString()
        let nl: number
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl); out = out.slice(nl + 1)
          processOut(line)
        }
      })

      // stderr：推理增量 + 诊断。用 `dsh: reasoning:` 那行做开关，`dsh: ` 开头的其它行是诊断
      // （没登录时报的 MISSING_CREDENTIAL 就是其中一条，必须原样露出来，别埋进折叠的推理里）。
      let err = ''
      let reasoning = false
      const processErr = (raw: string) => {
        const line = raw.trimEnd()
        if (!line.trim()) return
        if (line.trim() === 'dsh: reasoning:') { reasoning = true; return }
        if (/^dsh: /.test(line)) {
          reasoning = false
          cb.onLog({ ts: now(), text: line, level: 'info' })
          return
        }
        cb.onLog({ ts: now(), text: line, level: 'info', ...(reasoning ? { kind: 'think' as const } : {}) })
      }
      child.stderr?.on('data', (b: Buffer) => {
        cb.onActivity?.()
        err += b.toString()
        let nl: number
        while ((nl = err.indexOf('\n')) >= 0) {
          const line = err.slice(0, nl); err = err.slice(nl + 1)
          processErr(line)
        }
      })

      const done = child.then((res) => {
        processOut(out); out = ''       // 冲掉最后一行（可能没有换行结尾）
        processErr(err); err = ''
        for (const text of scanner.flush()) cb.onLog({ ts: now(), text, level: 'accent' })
        const ok = res.exitCode === 0
        cb.onState(ok ? 'ok' : 'err')
        const result = { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
        cb.onDone(result); return result
      }).catch((err) => { cb.onState('err'); cb.onError(err as Error); return { ok: false } })
      return { id: task.agentId, cancel: () => killTree(child), done }
    }
  }
}

/**
 * 权限档 → `DSH_PERMISSION_MODE`。
 *
 * ★没有档位时给 `workspace-write` —— 那本来就是它自己的默认值(见 composed config 里
 *  `process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`),显式写出来只是让这一轮的语义可读。
 */
export function dshPermissionMode(mode: PermissionMode | undefined): string {
  if (mode === 'readonly') return 'read-only'
  if (mode === 'full') return 'danger-full-access'
  return 'workspace-write'
}
