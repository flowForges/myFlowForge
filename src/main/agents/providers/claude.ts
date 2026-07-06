import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model, ChatTask, ChatCallbacks } from '../types'
import { parseChatStreamActions, buildChatPrompt, extractContextTokens, contextWindowFor } from '../chatStream'
import { forgeMcpArgs } from '../mcpConfig'
import { permissionArgs } from '../permissionArgs'
import { readClaudeModelsLive } from './claudeModels'

// The claude CLI's `--model` only accepts an alias ('opus'/'sonnet'/'haiku'/'fable') or a
// full name ('claude-opus-4-8'). Our friendly ids ('opus-4.8') are display labels and are
// NOT valid CLI args — passing one verbatim makes claude abort with "model may not exist".
// Translate id -> alias at the CLI boundary; pass through anything already valid.
const CLI_MODEL_ALIAS: Record<string, string> = {
  'opus-4.8': 'opus', 'sonnet-4.6': 'sonnet', 'haiku-4.5': 'haiku',
}
export function cliModel(id: string): string { return CLI_MODEL_ALIAS[id] ?? id }

function now() { return new Date().toISOString().slice(11, 19) }

export interface ClaudeSpec { bin?: string; preArgs?: string[]; defaultModels: Model[] }

// Exported for unit testing. Builds the CLI args for a run() invocation (non-preArgs path).
// When task.allowedTools has entries, injects '--allowedTools <name...>' after 'acceptEdits'
// and before '--model', so claude restricts the tool set to exactly the listed tools.
export function buildClaudeArgs(task: AgentTask, env: NodeJS.ProcessEnv): string[] {
  const allowedToolsArgs = task.allowedTools?.length
    ? ['--allowedTools', ...task.allowedTools]
    : []
  return [
    '-p', task.prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    ...allowedToolsArgs,
    '--model', cliModel(task.model),
    ...forgeMcpArgs(env),
  ]
}

export function makeClaudeProvider(spec: ClaudeSpec): AgentProvider {
  const bin = spec.bin ?? 'claude'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'claude',
    displayName: 'Claude Code',
    bin,
    capabilities: { structuredOutput: true, permissionHook: true, pty: false, mcpTools: true, liveModels: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    // claude has no --list-models; recover the real alias→version map by scanning its compiled
    // bundle (fail-open to []). Wired through the standard liveModels cache/refresh path in detect.ts.
    async listModelsLive(env: NodeJS.ProcessEnv): Promise<Model[]> { return readClaudeModelsLive(bin, env) },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      let args: string[]
      if (spec.preArgs) {
        args = [...spec.preArgs]
        // preArgs replaces the full arg list (test harness path) — no MCP injection
      } else {
        // --permission-mode acceptEdits: the human already approved the whole run via the hard
        // gate, so stage agents auto-accept file edits within the cwd (the isolated forge/ worktree)
        // instead of blocking on per-edit prompts in headless mode. Scoped to run() only — chat()
        // stays interactive.
        args = buildClaudeArgs(task, env)
      }
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      let buf = ''
      // Write a permission decision back to claude's stdin; tolerate a closed/dead stream
      // (e.g. the run was cancelled while a confirm was pending) instead of throwing.
      const reply = (allow: boolean) => {
        try { child.stdin?.write(JSON.stringify({ type: 'permission_response', allow }) + '\n') } catch { /* stdin gone */ }
      }
      let streamed = false
      let ctxMaxSeen = 0
      const KIND_LEVEL = { think: 'info', tool: 'accent', file: 'accent', output: 'accent' } as const
      const handle = async (obj: any) => {
        if (obj?.type === 'permission_request') {
          const decision = await cb.onConfirm({ title: `${obj.tool} 请求执行`, where: obj.path })
          reply(decision === 'allow'); return
        }
        const used = extractContextTokens(obj)
        if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) }
        if (obj?.type === 'stream_event') streamed = true
        if (obj?.type === 'assistant' && streamed) return   // deltas already streamed this turn; skip the full message to avoid duplicates
        for (const a of parseChatStreamActions(obj)) {
          if (a.kind === 'session') { cb.onSession?.(a.id); continue }
          if (a.kind === 'ignore') continue
          if (a.kind === 'result') { if (a.text) cb.onLog({ ts: now(), text: a.text, level: 'ok', kind: 'output' }); continue }
          const kind = a.kind === 'assistant' ? 'output' : a.kind
          cb.onLog({ ts: now(), text: a.text, level: KIND_LEVEL[kind], kind })
        }
      }
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch { cb.onLog({ ts: now(), text: line, level: 'info' }); return }
        // If onConfirm throws, deny so claude is never left blocked, and surface the error.
        handle(obj).catch((err) => { reply(false); cb.onError(err instanceof Error ? err : new Error(String(err))) })
      }
      child.stdout?.on('data', (b: Buffer) => {
        // Any stdout byte means the process is alive — including a long stream of input_json_delta
        // events (a big Write's content) that map to no log line. Signal liveness before parsing so
        // the orchestrator watchdog never kills a healthy agent mid-generation.
        cb.onActivity?.()
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          processLine(line)
        }
      })
      const done = child.then((res) => {
        processLine(buf); buf = '' // flush any final line that had no trailing newline (e.g. the result event)
        const ok = res.exitCode === 0
        cb.onState(ok ? 'ok' : 'err')
        const result = { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
        cb.onDone(result); return result
      }).catch((err) => { cb.onState('err'); cb.onError(err as Error); return { ok: false } })
      return { id: task.agentId, cancel: () => { child.kill('SIGTERM') }, done }
    },
    chat(task: ChatTask, cb: ChatCallbacks, env): AgentSession {
      // `-p --output-format stream-json` REQUIRES --verbose, otherwise claude exits with a
      // usage error and emits nothing → the reply renders blank ("only 思考中, no text").
      const args = spec.preArgs
        ? [...spec.preArgs]
        : ['-p', buildChatPrompt(task), '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...permissionArgs('claude', task.permissionMode ?? 'auto'), '--model', cliModel(task.model), ...forgeMcpArgs(env)]
      if (!spec.preArgs && task.sessionId) args.push('--resume', task.sessionId)
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      const start = Date.now()
      let buf = ''
      let streamed = false
      let ctxMaxSeen = 0
      const reply = (allow: boolean) => {
        try { child.stdin?.write(JSON.stringify({ type: 'permission_response', allow }) + '\n') } catch { /* stdin gone */ }
      }
      const handle = async (obj: any) => {
        if (obj?.type === 'permission_request') {
          const decision = cb.onConfirm ? await cb.onConfirm({ title: `${obj.tool} 请求执行`, where: obj.path }) : 'deny'
          reply(decision === 'allow'); return
        }
        const used = extractContextTokens(obj)
        if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) }
        if (obj?.type === 'stream_event') streamed = true
        if (obj?.type === 'assistant' && streamed) return   // deltas already streamed this; skip to avoid duplicate text
        for (const action of parseChatStreamActions(obj)) {
          if (action.kind === 'session') cb.onSession(action.id)
          else if (action.kind === 'assistant') cb.onAssistantDelta(action.text)
          else if (action.kind === 'think' || action.kind === 'tool' || action.kind === 'file') cb.onThinkDelta(action.text)
        }
      }
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch { cb.onAssistantDelta(line); return }
        handle(obj).catch((err) => { reply(false); cb.onError(err instanceof Error ? err : new Error(String(err))) })
      }
      child.stdout?.on('data', (b: Buffer) => {
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); processLine(line) }
      })
      const done = child.then((res) => {
        processLine(buf); buf = ''
        const elapsed = Math.round((Date.now() - start) / 1000)
        cb.onDone({ elapsed })
        return { ok: res.exitCode === 0, summary: res.exitCode === 0 ? '完成' : `退出码 ${res.exitCode}` }
      }).catch((err) => { cb.onError(err as Error); return { ok: false } })
      return { id: task.id, cancel: () => child.kill('SIGTERM'), done }
    }
  }
}
