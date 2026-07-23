import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model, ChatTask, ChatCallbacks } from '../types'
import { parseCursorEvent, cursorSessionId } from '../cursorStream'
import { createFenceScanner } from '../handoffFence'
import { buildChatPrompt } from '../chatStream'
import { parseModelsList } from '../parseModelsList'
import { provisionForgeMcp } from '../forgeMcpProvision'
import { forgeChatDirective } from '../forgeChatDirective'

function now() { return new Date().toISOString().slice(11, 19) }

const KIND_LEVEL = { think: 'info', tool: 'accent', file: 'accent', output: 'accent' } as const

export interface CursorSpec { bin?: string; preArgs?: string[]; defaultModels: Model[] }

// ⚠️ Model list is ASSUMED for cursor — not logged in; real available models unverifiable.
// defaultModels must be supplied by the caller (registry passes catalog values).
export function makeCursorProvider(spec: CursorSpec): AgentProvider {
  const bin = spec.bin ?? 'cursor-agent'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'cursor',
    displayName: 'Cursor Agent',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: true, mcpTools: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    async listModelsLive(env: NodeJS.ProcessEnv): Promise<Model[]> {
      try {
        // `cursor-agent models` reports the account's available models with a reliable exit code;
        // parseModelsList bails out on the auth-error string when not logged in.
        const { stdout } = await execa(bin, ['models'], { env, reject: false })
        return parseModelsList(stdout)
      } catch {
        return []
      }
    },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      let args: string[]
      if (spec.preArgs) {
        args = [...spec.preArgs]
      } else {
        const prov = provisionForgeMcp('cursor', env, task.cwd)
        args = [
          '-p', task.prompt,
          '--output-format', 'stream-json',
          '--stream-partial-output',
          '--force',
          '--workspace', task.cwd,
          ...(task.model ? ['--model', task.model] : []),
          ...prov.extraArgs,
        ]
      }
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      let buf = ''
      let rawErr = ''
      let sessionSent: string | undefined
      const cap = (s: string, add: string) => (s + add).slice(-2000)

      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch {
          // Non-JSON line: run through scanner at info level (fence fallback)
          const kept = scanner.feedLine(line)
          if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: 'info' })
          return
        }
        const sid = cursorSessionId(obj)
        if (sid && sid !== sessionSent) { sessionSent = sid; cb.onSession?.(sid) }
        const events = parseCursorEvent(obj)
        if (events.length === 0) {
          // Unrecognised JSON line: run through scanner so fence is detected
          const kept = scanner.feedLine(line)
          if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: 'info' })
          return
        }
        for (const ev of events) {
          const { kind, text } = ev
          // Feed output text through scanner for handoff fence detection
          if (kind === 'output') {
            const kept = text.split('\n').flatMap(l => scanner.feedLine(l))
            if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: KIND_LEVEL[kind], kind })
          } else {
            cb.onLog({ ts: now(), text, level: KIND_LEVEL[kind], kind })
          }
        }
      }

      child.stdout?.on('data', (b: Buffer) => {
        // Any stdout byte means the process is alive — signal liveness before parsing
        // so the orchestrator watchdog never kills a healthy agent mid-generation.
        cb.onActivity?.()
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          processLine(line)
        }
      })

      child.stderr?.on('data', (b: Buffer) => { rawErr = cap(rawErr, b.toString()) })

      const done = child.then((res) => {
        processLine(buf); buf = '' // flush any final line with no trailing newline
        for (const out of scanner.flush()) {
          cb.onLog({ ts: now(), text: out, level: 'info' })
        }
        const ok = res.exitCode === 0
        cb.onState(ok ? 'ok' : 'err')
        let summary = ok ? '完成' : `退出码 ${res.exitCode}`
        if (!ok && rawErr.trim()) summary += `\n${rawErr.trim()}`
        const result = { ok, summary }
        cb.onDone(result); return result
      }).catch((err) => { cb.onState('err'); cb.onError(err as Error); return { ok: false } })

      return { id: task.agentId, cancel: () => { child.kill('SIGTERM') }, done }
    },

    // (B) cursor chat() — mirrors qoder.chat() structure but uses parseCursorEvent.
    //
    // (D) Forge MCP for cursor: Tier 2 template.
    //   cursor-agent has no per-invocation --mcp-config flag (unlike claude/qoder), so
    //   provisionForgeMcp('cursor', ...) writes a project-local .cursor/mcp.json (merging any
    //   existing servers) and returns --approve-mcps to skip the per-tool approval prompt.
    //
    // Session ID: parseCursorEvent has no 'session' kind — cursor's session/thread ID
    //   shape is unverified (not logged in). onSession is a best-effort no-op for now;
    //   wire it when the real shape is confirmed with a logged-in cursor instance.
    chat(task: ChatTask, cb: ChatCallbacks, env): AgentSession {
      const prov = provisionForgeMcp('cursor', env, task.cwd)
      const directive = forgeChatDirective(env)
      const body = buildChatPrompt(task)
      const prompt = directive ? `${directive}\n\n${body}` : body
      const args = spec.preArgs
        ? [...spec.preArgs]
        : [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--stream-partial-output',
            '--force',
            '--workspace', task.cwd,
            ...(task.model ? ['--model', task.model] : []),
            ...(task.sessionId ? ['--resume', task.sessionId] : []),
            ...prov.extraArgs,
          ]
      if (prov.gitignoreHint) cb.onStatus?.(`已为 cursor 写入 ${prov.gitignoreHint}，建议加入 .gitignore`)
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      const start = Date.now()
      let buf = ''
      let gotText = false
      let sessionSent: string | undefined
      let toolN = 0   // cursor's stream carries no per-tool id → synthesize one per 执行 step
      let rawErr = ''
      child.stderr?.on('data', (b: Buffer) => { rawErr = (rawErr + b.toString()).slice(-2000) })
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch {
          // Non-JSON line: likely plain assistant text if the CLI degrades out of stream-json.
          gotText = true; cb.onAssistantDelta(line); return
        }
        const o = obj as any
        // Record the cursor session id (any envelope may carry it) so the IDs panel can show it —
        // previously never wired, so a cursor turn left no session row after switching providers.
        const sid = cursorSessionId(o)
        if (sid && sid !== sessionSent) { sessionSent = sid; cb.onSession(sid) }
        if (o.type === 'result') {
          // Final event. Only surface its text if nothing streamed, so partial deltas + the final
          // result don't render the whole answer twice.
          if (!gotText) for (const ev of parseCursorEvent(o)) if (ev.kind === 'output' && ev.text) { gotText = true; cb.onAssistantDelta(ev.text) }
          return
        }
        const events = parseCursorEvent(o)
        if (events.length === 0) {
          // Recognised-but-textless envelope (system/init · user echo · empty assistant): drop it. Any
          // other unknown JSON goes to the thinking trace — NEVER dumped into the answer body as raw
          // source (that was the "markdown 没渲染 / 能看到源码" symptom).
          if (o.type !== 'system' && o.type !== 'user' && o.type !== 'assistant') cb.onThinkDelta(line)
          return
        }
        for (const ev of events) {
          if (ev.kind === 'output') { gotText = true; cb.onAssistantDelta(ev.text) }
          // Cursor's stream exposes no per-tool id or output — surface each tool call as a title-only
          // 执行 step (synthesized id; marked done since there's no separate result event to await).
          else if (ev.kind === 'tool' || ev.kind === 'file') cb.onToolActivity?.({ id: `t${++toolN}`, phase: 'done', title: ev.text })
          else cb.onThinkDelta(ev.text)   // think → thinking trace
        }
      }
      child.stdout?.on('data', (b: Buffer) => {
        cb.onActivity?.()
        buf += b.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); processLine(line) }
      })
      const done = child.then((res) => {
        processLine(buf); buf = ''
        // Surface failures so the chat never just goes silent (cursor-agent likely errors to stderr
        // when not logged in or given an unsupported flag).
        if (res.exitCode !== 0 || !gotText) {
          const why = rawErr.trim() || (res.exitCode !== 0 ? `退出码 ${res.exitCode}` : '没有任何输出')
          cb.onAssistantDelta(`⚠️ Cursor Agent 执行失败:\n${why}`)
        }
        const elapsed = Math.round((Date.now() - start) / 1000)
        cb.onDone({ elapsed })
        return { ok: res.exitCode === 0, summary: res.exitCode === 0 ? '完成' : `退出码 ${res.exitCode}` }
      }).catch((err) => { cb.onError(err instanceof Error ? err : new Error(String(err))); return { ok: false } })
      return { id: task.id, cancel: () => child.kill('SIGTERM'), done }
    }
  }
}
