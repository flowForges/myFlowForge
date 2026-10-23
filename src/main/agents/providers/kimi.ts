import { execa, type ResultPromise } from 'execa'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnAgent, killTree } from '../procGroup'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model } from '../types'
import { acpProviderChat, runAsChat, type AcpProviderChatSpec } from '../acp/acpProvider'
import { guardedFallback } from '../acp/acpChat'
import { createFenceScanner } from '../handoffFence'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

// ★只读:print 模式会自动批准一切工具调用(--plan 不许和 -p 同用),唯一硬限制是 agent 定义里的工具表 ——
//  kimi-code 0.32.0 的 toolPolicy 对 profile 的 tools 做白名单(没列的内置工具、以及没写 mcp__ 模式的 MCP 工具
//  都不激活),disallowedTools 再兜一层。文件由 app 写到自己的临时目录(mkdtemp,0700),不碰工作区;
//  ${base_prompt} 保留 kimi 默认的系统提示词。WebSearch / FetchURL 不放。
//  依据 research.md §4 + 本机 kimi 0.32.0 包里的 parseAgentFileText / isToolActive,未真机探针。
export const KIMI_READONLY_AGENT_MD = [
  '---',
  'name: forge-readonly',
  'description: myFlowForge read-only agent (read and search only)',
  'tools: [Read, Glob, Grep, ReadMediaFile]',
  'disallowedTools: [Write, Edit, Bash, Agent, AgentSwarm, Skill, TaskStop, CronCreate, CronDelete, EnterPlanMode, ExitPlanMode, CreateGoal]',
  '---',
  '${base_prompt}',
  '',
  'Read-only mode: you cannot create, modify or delete files or run commands. Only read and search, then answer.',
  '',
].join('\n')

let readonlyAgentDir: string | undefined
/**
 * 只读 agent 文件的路径:每个进程一个固定路径。内容完好就不动;缺了 / 被改了才重写,且先写临时文件再 rename,
 * 并发的 kimi 进程永远读不到半截文件。临时目录被清掉也能自愈。
 */
export function kimiReadonlyAgentFile(): string {
  if (!readonlyAgentDir || !existsSync(readonlyAgentDir)) readonlyAgentDir = mkdtempSync(join(tmpdir(), 'myflowforge-kimi-'))
  const file = join(readonlyAgentDir, 'forge-readonly.md')
  let current: string | null = null
  try { current = readFileSync(file, 'utf8') } catch { /* 还没有 */ }
  if (current !== KIMI_READONLY_AGENT_MD) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, KIMI_READONLY_AGENT_MD)
    renameSync(tmp, file)
  }
  return file
}

export interface KimiSpec { bin?: string; defaultModels: Model[]; acp?: AcpProviderChatSpec['acp'] }

// Kimi Code CLI (MoonshotAI/kimi-code, npm @moonshot-ai/kimi-code, binary `kimi`) — the new TypeScript
// agent, NOT the legacy Python `kimi-cli`. Headless: `kimi -p "<prompt>" --output-format text` runs one
// turn and streams the assistant's reply to stdout (every line IS assistant output → 'accent', captured
// by the chat downgrade). Print mode implicitly enables --afk, auto-approving all tool calls, so no
// permission/sandbox flags are needed for a non-interactive run. `--model` selects a model; omitting it
// uses kimi's account default. Chat goes through ACP (`kimi acp`) — see the chat wiring below.
export function makeKimiProvider(spec: KimiSpec): AgentProvider {
  const bin = spec.bin ?? 'kimi'
  const defaultModels: Model[] = spec.defaultModels ?? []
  const provider: AgentProvider = {
    id: 'kimi',
    displayName: 'Kimi Code',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: false },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const directive = forgeChatDirective(env)
      const prompt = directive ? `${directive}\n\n${task.prompt}` : task.prompt
      const args = ['-p', prompt, '--output-format', 'text']
      if (task.permissionMode === 'readonly') args.push('--agent-file', kimiReadonlyAgentFile())
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
  // 聊天走 ACP(`kimi acp`,kimi-code 2.2.0 的子命令;本机未装,参数取自它发布包里的命令定义)。
  // ★`kimi acp` 不接受 `--model`(子命令只有 --login/--region),ACP 会话一律用账号默认模型。所以只有
  //  选的就是「账号默认」时才走 ACP;选了具体模型就直接走 run()(`-p --model`)—— 悄悄换掉用户选的模型
  //  比少一道门更糟。
  const acpChat = acpProviderChat({ bin, args: () => ['acp'], run: (t, c, e) => provider.run(t, c, e), acp: spec.acp })
  // ★选了具体模型那条直接走 run(),同样经 guardedFallback:没门的那条路要有人点头(见 ChatTask.beforeFallback)。
  // ★只读不走 ACP:会话权限取用户 config.toml 的 default_permission_mode(yolo/auto 时工具调用根本不来问门),
  //  而 -p + 只读 agent 文件是硬白名单;这条路本身就只读,不需要 guardedFallback 那道「以完全访问跑」的关口。
  provider.chat = (task, cb, env) => task.permissionMode === 'readonly'
    ? runAsChat((t, c, e) => provider.run(t, c, e), task, cb, env)
    : (!task.model || task.model === 'default')
    ? acpChat(task, cb, env)
    : guardedFallback(task, cb, () => runAsChat((t, c, e) => provider.run(t, c, e), task, cb, env), 'kimi acp 不吃 --model')
  return provider
}
