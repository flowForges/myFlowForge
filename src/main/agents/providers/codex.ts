import { execa, type ResultPromise } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model, ChatTask, ChatCallbacks } from '../types'
import { createFenceScanner } from '../handoffFence'
import { buildChatPrompt, extractContextTokens, contextWindowFor } from '../chatStream'
import { forgeCodexConfigArgs } from '../mcpConfig'
import { forgeChatDirective } from '../forgeChatDirective'
import { permissionArgs } from '../permissionArgs'
import { readCodexModelsCache } from './codexModels'
import { logError } from '../../log/appLog'
import { makeIdleWatchdog, CHAT_IDLE_MS } from '../idleWatchdog'

// codex (Rust) emits internal engine logs on stderr — e.g.
// `codex_models_manager::manager::failed to refresh available models: timeout waiting for child process to exit`
// — which are NOT part of the agent's answer. We surface codex stderr as chat "思考" (onStatus → think-delta),
// so these Rust module lines (`<crate>::<module>::…`) would show up as scary red noise every turn. Filter them
// out of the live display only; rawErr still keeps everything for the no-reply diagnostic path.
function isCodexInternalLog(line: string): boolean {
  return /^codex_[a-z0-9_]+::/.test(line)
}

// Render the spawned command for the debug log: clip each arg (the prompt can be huge) and the total.
function clipArgs(bin: string, args: string[]): string {
  const parts = [bin, ...args.map(a => { const s = String(a); return s.length > 160 ? s.slice(0, 160) + `…(+${s.length - 160})` : s })]
  const joined = parts.join(' ')
  return joined.length > 1200 ? joined.slice(0, 1200) + '…' : joined
}

// Always-available "account default" entry, shown ahead of the real local models.
const CODEX_DEFAULT_MODEL: Model = { id: 'default', label: '账号默认', description: 'codex 配置/账号的默认模型' }

// One codex `exec --json` JSONL event → chat actions. Codex nests the payload under `msg`.
export type CodexAction =
  | { kind: 'session'; id: string }
  | { kind: 'assistant'; text: string }        // streamed delta
  | { kind: 'assistant-final'; text: string }  // complete message (used only if no deltas streamed)
  | { kind: 'think'; text: string }
const clipCmd = (v: unknown) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > 200 ? s.slice(0, 200) + '…' : s }

export function parseCodexEvent(obj: any): CodexAction[] {
  if (!obj || typeof obj !== 'object') return []
  const out: CodexAction[] = []

  // --- Current Codex `exec --json` format: thread/turn/item lifecycle events ---
  if (obj.type === 'thread.started' && typeof obj.thread_id === 'string') return [{ kind: 'session', id: obj.thread_id }]
  if (obj.type === 'item.completed' && obj.item && typeof obj.item === 'object') {
    const it = obj.item
    const itype = String(it.type ?? it.item_type ?? '')
    const text = typeof it.text === 'string' ? it.text : (typeof it.message === 'string' ? it.message : '')
    if ((itype === 'assistant_message' || itype === 'agent_message') && text) out.push({ kind: 'assistant-final', text })
    else if ((itype === 'reasoning' || itype === 'agent_reasoning') && text) out.push({ kind: 'think', text })
    else if (itype === 'command_execution' || itype === 'exec_command') {
      const cmd = Array.isArray(it.command) ? it.command.join(' ') : String(it.command ?? '')
      if (cmd) out.push({ kind: 'think', text: `调用 shell: ${clipCmd(cmd)}` })
    }
    else if (itype === 'file_change' || itype === 'patch' || itype === 'apply_patch') {
      // Surface file edits as visible steps so the user sees what changed, not just a spinner.
      const changes = Array.isArray(it.changes) ? it.changes : (Array.isArray(it.files) ? it.files : [])
      const paths = changes.map((c: any) => (typeof c === 'string' ? c : (c?.path ?? c?.file ?? ''))).filter(Boolean)
      const label = paths.length ? paths.map((p: string) => clipCmd(p)).join(', ') : clipCmd(it.path ?? it.file ?? '')
      if (label) out.push({ kind: 'think', text: `编辑文件: ${label}` })
    }
    else if (itype === 'todo_list' && typeof it.text === 'string' && it.text) {
      out.push({ kind: 'think', text: `计划: ${clipCmd(it.text)}` })
    }
    return out
  }

  // --- Legacy format: payload nested under `msg`, flat agent_message/reasoning ---
  const m = obj.msg ?? obj
  const type = m?.type
  if (type === 'session_configured' && typeof m.session_id === 'string') out.push({ kind: 'session', id: m.session_id })
  else if (type === 'agent_message_delta' && typeof m.delta === 'string') out.push({ kind: 'assistant', text: m.delta })
  else if (type === 'agent_message' && typeof m.message === 'string') out.push({ kind: 'assistant-final', text: m.message })
  else if (type === 'agent_reasoning_delta' && typeof m.delta === 'string') out.push({ kind: 'think', text: m.delta })
  else if (type === 'agent_reasoning' && typeof m.text === 'string') out.push({ kind: 'think', text: m.text })
  else if (type === 'exec_command_begin') {
    const cmd = Array.isArray(m.command) ? m.command.join(' ') : String(m.command ?? '')
    if (cmd) out.push({ kind: 'think', text: `调用 shell: ${clipCmd(cmd)}` })
  }
  return out
}

type CodexActionLoggable = { kind: 'assistant' | 'assistant-final'; text: string } | { kind: 'think'; text: string }

/** Map a CodexAction (from parseCodexEvent) to the log level + kind for run() onLog. */
function codexKind(a: CodexActionLoggable): { level: 'info' | 'ok' | 'accent'; kind: 'think' | 'tool' | 'file' | 'output' } {
  if (a.kind === 'assistant-final' || a.kind === 'assistant') return { level: 'accent', kind: 'output' }
  // a.kind === 'think' — disambiguate by the pre-applied label prefix
  if (a.text.startsWith('调用 shell')) return { level: 'accent', kind: 'tool' }
  if (a.text.startsWith('编辑文件')) return { level: 'accent', kind: 'file' }
  return { level: 'info', kind: 'think' }
}

// Detect a turn/run failure event so the chat surfaces an error instead of an empty reply.
export function codexErrorMessage(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null
  if (obj.type === 'turn.failed') return String(obj.error?.message ?? obj.error ?? 'codex turn failed')
  // API errors (e.g. 400 model-not-supported) carry the real reason under `error.message`; some
  // shapes put it at the top level. Prefer the nested message so users see the actual cause.
  if (obj.type === 'error') {
    const nested = obj.error && typeof obj.error === 'object' ? obj.error.message : obj.error
    return String(obj.message ?? nested ?? 'codex error')
  }
  // Item-level error (e.g. config deprecation / model-not-supported arrives this way).
  if (obj.type === 'item.completed' && obj.item?.type === 'error') return String(obj.item.message ?? 'codex error')
  return null
}

// Only force `-m` for an explicitly-chosen non-default model.
function codexModelArgs(model: string): string[] { return model && model !== 'default' ? ['-m', model] : [] }

// The forge_propose_plan chat directive now lives in ../forgeChatDirective (shared with qoder,
// which also can't see .claude/skills). Re-exported here for existing importers/tests.
export { forgeChatDirective } from '../forgeChatDirective'
function now() { return new Date().toISOString().slice(11, 19) }

export interface CodexSpec { bin?: string; preArgs?: string[]; defaultModels: Model[] }

export function makeCodexProvider(spec: CodexSpec): AgentProvider {
  const bin = spec.bin ?? 'codex'
  const defaultModels: Model[] = spec.defaultModels ?? []
  return {
    id: 'codex',
    displayName: 'Codex',
    bin,
    capabilities: { structuredOutput: true, permissionHook: false, pty: false, mcpTools: true, liveModels: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    // Read real local models from ~/.codex/models_cache.json; fall back to the static defaults
    // only when the cache is missing (so the list is never empty on a fresh install).
    async listModels() { const local = readCodexModelsCache(); return local.length ? [CODEX_DEFAULT_MODEL, ...local] : defaultModels },
    async listModelsLive() { const local = readCodexModelsCache(); return local.length ? [CODEX_DEFAULT_MODEL, ...local] : [] },
    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const args = spec.preArgs
        ? [...spec.preArgs]
        : ['exec', '--ignore-user-config', '--json', '--skip-git-repo-check', ...permissionArgs('codex', task.permissionMode ?? 'auto'), ...codexModelArgs(task.model), ...forgeCodexConfigArgs(env), task.prompt]
      // stdin: 'ignore' so codex doesn't block waiting on stdin (the same hang as chat()).
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false, stdin: spec.preArgs ? undefined : 'ignore' })
      let buf = ''
      let ctxMaxSeen = 0
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch {
          // Garbage / non-JSON raw line: run through scanner at info level
          const kept = scanner.feedLine(line)
          if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: 'info' })
          return
        }
        // Codex usage (if present in a claude-compatible shape) feeds the same context bar; when
        // codex's usage shape differs, extractContextTokens returns null and the bar simply omits.
        const used = extractContextTokens(obj)
        if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) }
        // Try parseCodexEvent first — it handles both item format and legacy msg format.
        const actions = parseCodexEvent(obj)
        if (actions.length > 0) {
          for (const a of actions) {
            if (a.kind === 'session') { cb.onSession?.(a.id); continue }  // forward session id to sidecar
            const loggable = a as CodexActionLoggable
            const { level, kind } = codexKind(loggable)
            const kept = loggable.text.split('\n').flatMap(l => scanner.feedLine(l))
            if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level, kind })
          }
          return
        }
        // parseCodexEvent returned nothing — fall back to the legacy level heuristic for
        // lifecycle events (task_complete, result) and handoff fence bodies.
        const o = obj as Record<string, any>
        const t = o.msg?.type ?? o.type
        const text = o.msg?.message ?? o.text ?? o.message
        if (typeof text !== 'string' || text === '') {
          // A JSON line with no recognised codex event type may be a handoff fence body
          // (handoff JSON is always valid JSON). Fail-open through the scanner so the fence
          // is detected and the line isn't silently dropped; recognised type-less-text
          // events (lifecycle noise) still fall through and are ignored.
          if (t === undefined) {
            const kept = scanner.feedLine(line)
            if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: 'info' })
          }
          return
        }
        let level: 'accent' | 'ok' | 'info'
        if (t === 'agent_message' || t === 'assistant') level = 'accent'
        else if (t === 'task_complete' || t === 'result') level = 'ok'
        else level = 'info'
        const kept = String(text).split('\n').flatMap(l => scanner.feedLine(l))
        if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level })
      }
      child.stdout?.on('data', (b: Buffer) => {
        // Any stdout byte means the process is alive — including in-flight item.started/updated
        // lifecycle events that map to no log line. Signal liveness before parsing so the
        // orchestrator watchdog never kills a healthy agent mid-generation.
        cb.onActivity?.()
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
          cb.onLog({ ts: now(), text: out, level: 'info' })
        }
        const ok = res.exitCode === 0
        if (!ok) {
          const stderr = String(res.stderr ?? '').trim()
          logError('codex', `run 失败 · 退出码 ${res.exitCode}`, [
            `cmd: ${clipArgs(bin, args)}`,
            `cwd: ${task.cwd}`,
            stderr ? `stderr: ${stderr.slice(-1500)}` : '',
          ].filter(Boolean).join('\n'))
        }
        cb.onState(ok ? 'ok' : 'err')
        const result = { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
        cb.onDone(result); return result
      }).catch((err) => {
        logError('codex', 'run 异常', `${(err as Error)?.message ?? err}\ncmd: ${clipArgs(bin, args)}\ncwd: ${task.cwd}`)
        cb.onState('err'); cb.onError(err as Error); return { ok: false }
      })
      return { id: task.agentId, cancel: () => { child.kill('SIGTERM') }, done }
    },
    chat(task: ChatTask, cb: ChatCallbacks, env): AgentSession {
      // Non-interactive: --skip-git-repo-check (a workspace root may not be a git repo) and
      // approval_policy=never so codex never blocks waiting for an approval response (the
      // earlier "stuck on 思考中" hang). workspace-write lets it operate inside the cwd.
      // Resume the prior turn natively when we have a stored thread id, so codex sees the full
      // conversation (its own earlier 1/2/3 proposal etc.) instead of starting fresh each turn.
      // `codex exec resume <SESSION_ID> [PROMPT]` — SESSION_ID is the thread.started thread_id.
      const head = task.sessionId ? ['exec', 'resume', task.sessionId] : ['exec']
      const directive = forgeChatDirective(env)
      const body = buildChatPrompt(task)
      const prompt = directive ? `${directive}\n\n${body}` : body
      // codex only executes an MCP tool call when sandbox_mode is danger-full-access; with
      // read-only/workspace-write it treats the call as a sandbox escape and — since approval_policy
      // is "never" — cancels it ("user cancelled MCP tool call"), so chat-initiated forge_delegate /
      // forge_propose_plan never reach the bridge. When forge is injected, force full access for the
      // chat orchestrator (its real read/write work is delegated to separately-sandboxed sub-agents).
      const forgeCodexArgs = forgeCodexConfigArgs(env)
      const codexPermArgs = forgeCodexArgs.length
        ? ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"']
        : permissionArgs('codex', task.permissionMode ?? 'auto')
      const args = spec.preArgs
        ? [...spec.preArgs]
        // --ignore-user-config: bypass the user's ~/.codex/config.toml — its oh-my-codex hooks
        // (session_start/user_prompt_submit/etc.) block `codex exec` and produce no reply. Auth
        // still works (it lives outside config.toml), and the account's default model is used.
        // sandbox via `-c sandbox_mode` (NOT `-s`): `codex exec resume` rejects the `-s`/`--sandbox`
        // flag ("unexpected argument '-s'"), but accepts the config override — and so does plain `exec`.
        : [...head, '--ignore-user-config', '--json', '--skip-git-repo-check', ...codexPermArgs, ...codexModelArgs(task.model), ...forgeCodexArgs, prompt]
      // stdin: 'ignore' so codex doesn't block reading stdin. A wedged turn is reclaimed by an
      // INACTIVITY watchdog (below) — NOT a hard wall-clock timeout, which used to kill long-but-
      // healthy turns (a big input reads/reasons past 180s → killed with zero output → "chat 无回复").
      const child: ResultPromise = execa(bin, args, { cwd: task.cwd, env, reject: false, stdin: 'ignore' })
      const wd = makeIdleWatchdog(CHAT_IDLE_MS, () => { try { child.kill('SIGTERM') } catch { /* already gone */ } })
      const start = Date.now()
      let buf = ''
      let sawDelta = false
      let lastErr: string | null = null
      let rawOut = ''   // raw stdout we couldn't turn into assistant/think output
      let rawErr = ''   // raw stderr (codex logs/errors)
      let errBuf = ''   // stderr line-splitter for live onStatus forwarding
      let ctxMaxSeen = 0
      const cap = (s: string, add: string) => (s + add).slice(-2000)   // keep a bounded tail
      const handle = (obj: unknown) => {
        const err = codexErrorMessage(obj)
        if (err) lastErr = err
        // Best-effort context usage: codex's chat events rarely carry a claude-compatible usage
        // object, so extractContextTokens usually returns null and the bar simply omits. Kept for
        // symmetry with run() so a compatible usage shape would feed the session context meter.
        const used = extractContextTokens(obj)
        if (used != null && used > ctxMaxSeen) { ctxMaxSeen = used; cb.onUsage?.({ used: ctxMaxSeen, window: contextWindowFor(task.model) }) }
        for (const a of parseCodexEvent(obj)) {
          if (a.kind === 'session') cb.onSession(a.id)
          else if (a.kind === 'assistant') { sawDelta = true; cb.onAssistantDelta(a.text) }
          else if (a.kind === 'assistant-final') { if (!sawDelta) cb.onAssistantDelta(a.text) }
          else if (a.kind === 'think') cb.onThinkDelta(a.text)
        }
      }
      const processLine = (raw: string) => {
        const line = raw.trim()
        if (!line) return
        rawOut = cap(rawOut, line + '\n')
        try { handle(JSON.parse(line)) } catch { /* non-JSON banner line — kept in rawOut for diagnostics */ }
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
        while ((nl = errBuf.indexOf('\n')) >= 0) { const line = errBuf.slice(0, nl).trim(); errBuf = errBuf.slice(nl + 1); if (line && !isCodexInternalLog(line)) cb.onStatus?.(line) }
      })
      const done = child.then((res) => {
        wd.clear()
        processLine(buf); buf = ''
        if (errBuf.trim() && !isCodexInternalLog(errBuf.trim())) { cb.onStatus?.(errBuf.trim()); errBuf = '' }
        // No reply produced → surface the best diagnostic we have so it's never a silent empty bubble:
        // a parsed error event, else the raw stderr/stdout codex emitted, else a bare exit-code note.
        if (!sawDelta) {
          let diag = lastErr ?? ''
          if (!diag && (wd.firedFlag || res.timedOut)) diag = 'codex 长时间无响应（240s 无任何输出）已终止 —— 可尝试拆分过长的输入，或检查网络/实验功能配置'
          if (!diag && rawErr.trim()) diag = `codex stderr:\n${rawErr.trim()}`
          if (!diag && rawOut.trim()) diag = `codex 输出(未解析):\n${rawOut.trim()}`
          if (!diag) diag = `codex 无输出 (退出码 ${res.exitCode})`
          cb.onError(new Error(diag))
          logError('codex', 'chat 无回复', `cmd: ${clipArgs(bin, args)}\ncwd: ${task.cwd}\n${diag}`)
        } else if (res.exitCode !== 0) {
          logError('codex', `chat 退出码 ${res.exitCode}`, [`cmd: ${clipArgs(bin, args)}`, rawErr.trim() ? `stderr: ${rawErr.trim()}` : ''].filter(Boolean).join('\n'))
        }
        const elapsed = Math.round((Date.now() - start) / 1000)
        cb.onDone({ elapsed })
        return { ok: res.exitCode === 0, summary: res.exitCode === 0 ? '完成' : `退出码 ${res.exitCode}` }
      }).catch((err) => {
        wd.clear()
        logError('codex', 'chat 异常', `${(err as Error)?.message ?? err}\ncmd: ${clipArgs(bin, args)}\ncwd: ${task.cwd}`)
        cb.onError(err as Error); return { ok: false }
      })
      return { id: task.id, cancel: () => { wd.clear(); child.kill('SIGTERM') }, done }
    }
  }
}
