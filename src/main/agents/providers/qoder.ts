import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model, ChatTask, ChatCallbacks } from '../types'
import { parseChatStreamActions, buildChatPrompt, extractContextTokens, contextWindowFor, splitThinkLines } from '../chatStream'
import { createFenceScanner } from '../handoffFence'
import { forgeMcpArgs, forgeAllowedToolNames } from '../mcpConfig'
import { permissionArgs } from '../permissionArgs'
import { forgeChatDirective } from '../forgeChatDirective'
import { parseModelsList } from '../parseModelsList'
import { logError, logWarn } from '../../log/appLog'

function now() { return new Date().toISOString().slice(11, 19) }

// Render the spawned command for the debug log (clip the big prompt arg + total).
function clipArgs(bin: string, args: string[]): string {
  const parts = [bin, ...args.map(a => { const s = String(a); return s.length > 160 ? s.slice(0, 160) + `…(+${s.length - 160})` : s })]
  const joined = parts.join(' ')
  return joined.length > 1200 ? joined.slice(0, 1200) + '…' : joined
}

// A resume failure that means the stored id isn't valid for THIS provider/session store (stale,
// expired, or minted by a different CLI when the user switched coding agents mid-session).
const INVALID_SESSION_RE = /invalid session identifier|session not found|no (such )?session|unknown session|no rollout/i

const KIND_LEVEL = { think: 'info', tool: 'accent', file: 'accent', output: 'accent' } as const

export interface QoderSpec { bin?: string; preArgs?: string[]; defaultModels: Model[] }

export function makeQoderProvider(spec: QoderSpec): AgentProvider {
  const bin = spec.bin ?? 'qodercli'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'qoder',
    displayName: 'Qoder',
    bin,
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true, liveModels: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { return defaultModels },
    async listModelsLive(env: NodeJS.ProcessEnv): Promise<Model[]> {
      try {
        const { stdout } = await execa(bin, ['--list-models'], { env, reject: false })
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
        args = [
          '-p', task.prompt,
          '--output-format', 'stream-json',
          // qodercli is claude-compatible for `-p --output-format stream-json` and accepts
          // --include-partial-messages (incremental deltas), but it does NOT accept claude's
          // `--verbose` — passing it makes qodercli print usage and exit with NO stdout
          // (→ "nothing returned"). So we must omit --verbose here.
          '--include-partial-messages',
          ...permissionArgs('qoder', task.permissionMode ?? 'auto'),
          '--dangerously-skip-permissions',
          '--cwd', task.cwd,
          ...(task.model && task.model !== 'default' ? ['-m', task.model] : []),
          ...(task.allowedTools?.length ? task.allowedTools.flatMap(t => ['--allowed-tools', t]) : []),
          ...forgeMcpArgs(env),
        ]
      }
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
      let buf = ''
      let rawErr = ''
      let ctxMaxSeen = 0
      const cap = (s: string, add: string) => (s + add).slice(-2000)

      // Same word-fragment reasoning as chat() — coalesce think deltas into whole log lines so the
      // workflow console doesn't show one word per line. See splitThinkLines.
      let thinkBuf = ''
      const pushThink = (t: string) => {
        const { lines, rest } = splitThinkLines(thinkBuf + t)
        for (const l of lines) cb.onLog({ ts: now(), text: l, level: KIND_LEVEL['think'], kind: 'think' })
        thinkBuf = rest
      }
      const flushThink = () => { const t = thinkBuf.trim(); thinkBuf = ''; if (t) cb.onLog({ ts: now(), text: t, level: KIND_LEVEL['think'], kind: 'think' }) }

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
        const used = extractContextTokens(obj)
        if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) }
        const actions = parseChatStreamActions(obj)
        if (actions.length === 0) {
          // Unrecognised JSON line (e.g. handoff fence body JSON): run through scanner so the
          // fence is detected and the line isn't silently dropped.
          const kept = scanner.feedLine(line)
          if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: 'info' })
          return
        }
        for (const a of actions) {
          if (a.kind === 'session') { cb.onSession?.(a.id); continue }
          if (a.kind === 'ignore') continue
          if (a.kind === 'think') { pushThink(a.text ?? ''); continue }
          flushThink()   // any non-think action closes the current buffered reasoning line
          if (a.kind === 'subagent-start') { cb.onLog({ ts: now(), text: `调用子代理 ${a.subagentType ?? ''}${a.description ? ' · ' + a.description : ''}`.trim(), level: 'accent', kind: 'tool' }); continue }
          if (a.kind === 'subagent-result') continue
          if (a.kind === 'result') {
            if (a.text) {
              // Feed result text through scanner too (handoff could appear there)
              const kept = a.text.split('\n').flatMap(l => scanner.feedLine(l))
              if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: 'ok', kind: 'output' })
            }
            continue
          }
          const kind = a.kind === 'assistant' ? 'output' : a.kind
          const text = a.text ?? ''
          // Feed assistant/output text through scanner for handoff fence detection
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
        flushThink()   // surface any trailing reasoning line with no closing newline
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
    chat(task: ChatTask, cb: ChatCallbacks, env): AgentSession {
      const start = Date.now()
      let cancelled = false
      let activeChild: ResultPromise | null = null

      // qoder reads .qoder/skills, never the workspace's .claude/skills/forge-workflow skill, so —
      // like codex — inline the forge_propose_plan guidance when the chat bridge exposes the tool
      // (env.FORGE_TOOLS). Fail-open: directive is '' without FORGE_TOOLS → prompt unchanged.
      const directive = forgeChatDirective(env)
      const body = buildChatPrompt(task)
      const prompt = directive ? `${directive}\n\n${body}` : body
      const baseArgs = (): string[] => spec.preArgs
        ? [...spec.preArgs]
        : [
            '-p', prompt,
            '--output-format', 'stream-json',
            // qodercli rejects claude's `--verbose` (prints usage + exits with no stdout); only
            // --include-partial-messages is needed for the streamed deltas.
            '--include-partial-messages',
            ...permissionArgs('qoder', task.permissionMode ?? 'auto'),
            // Pre-grant the forge MCP tools (same as claude): without --allowed-tools qoder blocks
            // the call in headless mode and forge_delegate / forge_propose_plan never run.
            ...forgeAllowedToolNames(env).flatMap(t => ['--allowed-tools', t]),
            '--cwd', task.cwd,
            ...(task.model && task.model !== 'default' ? ['-m', task.model] : []),
            ...forgeMcpArgs(env),
          ]

      // One spawn. `useResume` adds --resume; on an invalid-session rejection we retry with it off.
      const attempt = (useResume: boolean): Promise<{ ok: boolean }> => {
        const args = baseArgs()
        if (!spec.preArgs && useResume && task.sessionId) args.push('--resume', task.sessionId)
        const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false })
        activeChild = child
        let buf = ''
        let streamed = false
        let gotText = false
        let rawErr = ''
        let ctxMaxSeen = 0
        child.stderr?.on('data', (b: Buffer) => { rawErr = (rawErr + b.toString()).slice(-2000) })
        // Reasoning arrives as word-level `thinking_delta` fragments (--include-partial-messages), so
        // buffer them and only emit whole lines — otherwise the think panel shows one word per line.
        // Discrete steps (tool/file labels) flush the buffer first so they stay on their own line.
        let thinkBuf = ''
        const pushThink = (t: string) => {
          const { lines, rest } = splitThinkLines(thinkBuf + t)
          for (const l of lines) cb.onThinkDelta(l)
          thinkBuf = rest
        }
        const flushThink = () => { if (thinkBuf.trim()) cb.onThinkDelta(thinkBuf.trim()); thinkBuf = '' }
        const handle = (obj: any) => {
          const used = extractContextTokens(obj)
          if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) }
          if (obj?.type === 'stream_event') streamed = true
          if (obj?.type === 'assistant' && streamed) return   // deltas already streamed; skip to avoid duplicates
          for (const action of parseChatStreamActions(obj)) {
            if (action.kind === 'session') cb.onSession(action.id)
            else if (action.kind === 'assistant') { flushThink(); gotText = true; cb.onAssistantDelta(action.text) }
            else if (action.kind === 'think') pushThink(action.text)
            else if (action.kind === 'tool' || action.kind === 'file') { flushThink(); cb.onThinkDelta(action.text) }
          }
        }
        const processLine = (raw: string) => {
          const line = raw.trim()
          if (!line) return
          let obj: unknown
          try { obj = JSON.parse(line) } catch { gotText = true; cb.onAssistantDelta(line); return }
          handle(obj)
        }
        child.stdout?.on('data', (b: Buffer) => {
          cb.onActivity?.()
          buf += b.toString()
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); processLine(line) }
        })
        return child.then((res) => {
          processLine(buf); buf = ''
          flushThink()   // surface any trailing reasoning line that never got a closing newline
          // Self-heal: a --resume rejected because the stored id is stale/expired/foreign (e.g. the
          // user ran codex/claude on this session before switching to qoder — session ids are NOT
          // interchangeable across CLIs). Retry once WITHOUT --resume; the fresh turn mints a new
          // valid qoder id (emitted via onSession) that overwrites the bad one for future turns.
          if (useResume && !!task.sessionId && !gotText && res.exitCode !== 0 && INVALID_SESSION_RE.test(rawErr) && !cancelled) {
            logWarn('qoder', 'resume 会话标识无效,自动改为新开会话重试', `resume id: ${task.sessionId}\ncwd: ${task.cwd}\n${rawErr.trim().slice(-600)}`)
            return attempt(false)
          }
          // Surface real failures so the chat never just goes silent (auth error, bad flag, not installed).
          if (res.exitCode !== 0 || !gotText) {
            const why = rawErr.trim() || (res.exitCode !== 0 ? `退出码 ${res.exitCode}` : '没有任何输出')
            cb.onAssistantDelta(`⚠️ Qoder 执行失败:\n${why}`)
            logError('qoder', `chat ${res.exitCode !== 0 ? '退出码 ' + res.exitCode : '无输出'}`, `cmd: ${clipArgs(bin, args)}\ncwd: ${task.cwd}\n${rawErr.trim()}`)
          }
          return { ok: res.exitCode === 0 }
        })
      }

      const done = attempt(!!task.sessionId).then((r) => {
        cb.onDone({ elapsed: Math.round((Date.now() - start) / 1000) })
        return { ok: r.ok, summary: r.ok ? '完成' : '失败' }
      }).catch((err) => { cb.onError(err instanceof Error ? err : new Error(String(err))); return { ok: false } })
      return { id: task.id, cancel: () => { cancelled = true; activeChild?.kill('SIGTERM') }, done }
    }
  }
}
