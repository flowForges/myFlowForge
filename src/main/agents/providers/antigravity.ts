import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model, ChatTask, ChatCallbacks } from '../types'
import { buildChatPrompt, contextWindowFor } from '../chatStream'
import { createFenceScanner } from '../handoffFence'
import { forgeChatDirective } from '../forgeChatDirective'
import { permissionArgs } from '../permissionArgs'
import { parseModelsList } from '../parseModelsList'
import { makeIdleWatchdog, CHAT_IDLE_MS } from '../idleWatchdog'
import { logError, appLog } from '../../log/appLog'
import { parseAgyActions, agyTurnTokens, agyContextTokens } from './antigravityStream'

function now() { return new Date().toISOString().slice(11, 19) }

// Google Antigravity CLI —— 安装后的命令名是 `agy`(下载下来的二进制文件名叫 antigravity,但它自报的用法是
// `agy --print "…"`,`agy install` 负责把它挂进 PATH)。想用别的路径在 设置 → 代理 里改 bin。
//
// 无头接法:`agy -p "<prompt>" --output-format stream-json`,NDJSON 事件见 antigravityStream.ts。
// 续聊靠 `--conversation <conversation_id>`(id 从上一轮事件里取)。
//
// 权限:它【没有】逐操作审批协议(--help 里只有 --mode 与 --dangerously-skip-permissions),文档说无头模式下
// 由策略决定 —— 工作区内文件自动放行、shell 默认软拒绝。所以 permissionHook=false,三档权限映射成 --mode
// 与 --dangerously-skip-permissions(见 permissionArgs.ts),app 不去代改它的 settings.json。
//
// MCP:它自己支持 MCP,但没有 claude/codex 那样的「本次调用注入一份 MCP 配置」的命令行开关,所以 forge 工具
// 注入不进去 → mcpTools=false(委派/工单交接走围栏文本,不走 MCP)。
export interface AntigravitySpec { bin?: string; preArgs?: string[]; defaultModels: Model[] }

// `agy models` 会先打一行进度再列模型;那行不是模型,喂给 parseModelsList 会变成一条假模型。
export function stripModelsProgress(stdout: string): string {
  return stdout.split('\n').filter(l => !/^\s*(fetching|loading)\b/i.test(l)).join('\n')
}

export function makeAntigravityProvider(spec: AntigravitySpec): AgentProvider {
  const bin = spec.bin ?? 'agy'
  const defaultModels: Model[] = spec.defaultModels ?? []

  const baseArgs = (model: string, mode: AgentTask['permissionMode']) => [
    '--output-format', 'stream-json',
    ...permissionArgs('antigravity', mode ?? undefined),
    ...(model && model !== 'default' ? ['--model', model] : []),
  ]

  return {
    id: 'antigravity',
    displayName: 'Antigravity',
    bin,
    capabilities: { structuredOutput: true, permissionHook: false, pty: false, mcpTools: false, liveModels: true },
    async detect() { try { await execa(bin, ['--help']); return true } catch { return false } },
    async listModels() { return defaultModels },
    // `agy models` 需要登录;没登录时它打的是一句 "Please sign in…",parseModelsList 认得出这是错误文案
    // 并返回 [] → 上层回退到静态目录。fail-open,绝不因为拿不到模型就让 provider 不可用。
    async listModelsLive(env: NodeJS.ProcessEnv): Promise<Model[]> {
      try {
        const res = await execa(bin, ['models'], { env, reject: false })
        return parseModelsList(stripModelsProgress(`${res.stdout ?? ''}\n${res.stderr ?? ''}`))
      } catch { return [] }
    },

    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const directive = forgeChatDirective(env)
      const prompt = directive ? `${directive}\n\n${task.prompt}` : task.prompt
      const args = spec.preArgs ? [...spec.preArgs] : ['-p', prompt, ...baseArgs(task.model, task.permissionMode)]
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      const wd = makeIdleWatchdog(CHAT_IDLE_MS, () => { try { child.kill('SIGTERM') } catch { /* already gone */ } })
      let turnOk: boolean | null = null
      let buf = ''

      const handle = (obj: unknown) => {
        for (const a of parseAgyActions(obj)) {
          if (a.kind === 'session') { cb.onSession?.(a.id); continue }
          if (a.kind === 'ignore') continue
          if (a.kind === 'result') {
            turnOk = a.ok
            if (a.error) cb.onLog({ ts: now(), text: a.error, level: 'info' })
            continue
          }
          if (a.kind === 'tool-result') continue   // run 路径没有「执行」块,工具输出不单独成行
          if (a.kind === 'tool') { cb.onLog({ ts: now(), text: a.text, level: 'accent', kind: 'tool' }); continue }
          // assistant 正文:过一遍交接围栏扫描器(forge_handoff 的文本降级通道)
          for (const out of scanner.feedLine(a.text)) cb.onLog({ ts: now(), text: out, level: 'accent', kind: 'output' })
        }
      }
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch { cb.onLog({ ts: now(), text: line, level: 'info' }); return }
        handle(obj)
      }
      child.stdout?.on('data', (b: Buffer) => {
        wd.beat(); cb.onActivity?.()
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); processLine(line) }
      })
      const done = child.then((res) => {
        wd.clear()
        processLine(buf); buf = ''
        for (const out of scanner.flush()) cb.onLog({ ts: now(), text: out, level: 'accent', kind: 'output' })
        const ok = turnOk ?? (res.exitCode === 0)
        cb.onState(ok ? 'ok' : 'err')
        const result = { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
        cb.onDone(result); return result
      }).catch((err) => { wd.clear(); cb.onState('err'); cb.onError(err as Error); return { ok: false } })
      return { id: task.agentId, cancel: () => { wd.clear(); child.kill('SIGTERM') }, done }
    },

    chat(task: ChatTask, cb: ChatCallbacks, env): AgentSession {
      const directive = forgeChatDirective(env)
      const chatPrompt = directive ? `${directive}\n\n${buildChatPrompt(task)}` : buildChatPrompt(task)
      const args = spec.preArgs
        ? [...spec.preArgs]
        : ['-p', chatPrompt, ...baseArgs(task.model, task.permissionMode),
           ...(task.sessionId ? ['--conversation', task.sessionId] : [])]
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      const wd = makeIdleWatchdog(CHAT_IDLE_MS, () => { try { child.kill('SIGTERM') } catch { /* already gone */ } })
      const start = Date.now()
      let buf = ''
      let errBuf = ''
      let rawErr = ''
      let sawAssistant = false
      let sawTool = false
      let turnOk: boolean | null = null
      let resultErr = ''
      let ctxMaxSeen = 0
      const cap = (s: string, add: string) => (s + add).slice(-2000)

      const handle = (obj: unknown) => {
        { const t = agyTurnTokens(obj); if (t) cb.onTurnTokens?.(t) }
        { const used = agyContextTokens(obj); if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) } }
        for (const a of parseAgyActions(obj)) {
          if (a.kind === 'session') { cb.onSession(a.id); continue }
          if (a.kind === 'ignore') continue
          if (a.kind === 'result') {
            turnOk = a.ok
            if (a.error) resultErr = a.error
            continue
          }
          if (a.kind === 'tool') {
            sawTool = true
            if (a.id) cb.onToolActivity?.({ id: a.id, phase: 'start', name: a.name, title: a.text })
            else cb.onThinkDelta(a.text)
            continue
          }
          if (a.kind === 'tool-result') { cb.onToolActivity?.({ id: a.id, phase: 'done', output: a.result, isError: a.isError }); continue }
          sawAssistant = true
          cb.onAssistantDelta(a.text)
        }
      }
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        // 非 JSON 行是 CLI 自己的提示(比如登录 URL),当状态行给出去,别混进回答正文。
        try { obj = JSON.parse(line) } catch { cb.onStatus?.(line); return }
        handle(obj)
      }
      child.stdout?.on('data', (b: Buffer) => {
        wd.beat()
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); processLine(line) }
      })
      child.stderr?.on('data', (b: Buffer) => {
        wd.beat()
        const s = b.toString()
        rawErr = cap(rawErr, s)
        errBuf += s
        let nl: number
        while ((nl = errBuf.indexOf('\n')) >= 0) { const line = errBuf.slice(0, nl).trim(); errBuf = errBuf.slice(nl + 1); if (line) cb.onStatus?.(line) }
      })
      const done = child.then((res) => {
        wd.clear()
        processLine(buf); buf = ''
        if (errBuf.trim()) cb.onStatus?.(errBuf.trim()); errBuf = ''
        const elapsed = Math.round((Date.now() - start) / 1000)
        if (!sawAssistant && !sawTool) {
          // result 事件带的 error 是最准的原因(未登录就是在这里说 "authentication failed or timed out"),
          // 优先用它,而不是把一堆 stderr 丢给用户。
          const diag = resultErr
            || (wd.firedFlag ? 'antigravity 长时间无响应（240s 无任何输出）已终止' : '')
            || (rawErr.trim() ? `agy stderr:\n${rawErr.trim()}` : `agy 无输出 (退出码 ${res.exitCode})`)
          logError('antigravity', 'chat 无回复', `cwd: ${task.cwd}\n${diag}`)
          cb.onError(new Error(diag))
          return { ok: false, summary: diag }
        }
        appLog('info', 'antigravity', `chat 结束 · 退出码 ${res.exitCode} · ${elapsed}s · 文本=${sawAssistant} 工具=${sawTool} result收尾=${turnOk != null} 看门狗=${wd.firedFlag}`)
        cb.onDone({ elapsed })
        const ok = turnOk ?? (res.exitCode === 0)
        return { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
      }).catch((err) => { wd.clear(); cb.onError(err as Error); return { ok: false } })
      return { id: task.id, cancel: () => { wd.clear(); child.kill('SIGTERM') }, done }
    },
  }
}
