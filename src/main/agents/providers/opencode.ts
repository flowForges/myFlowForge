import { execa } from 'execa'
import type { AgentProvider, AgentTask, AgentCallbacks, AgentSession, Model, ChatTask, ChatCallbacks } from '../types'
import { createFenceScanner } from '../handoffFence'
import { buildChatPrompt, contextWindowFor } from '../chatStream'
import { forgeChatDirective } from '../forgeChatDirective'
import { logError } from '../../log/appLog'
import { makeIdleWatchdog, CHAT_IDLE_MS } from '../idleWatchdog'

function now() { return new Date().toISOString().slice(11, 19) }
function clipArgs(bin: string, args: string[]): string {
  const parts = [bin, ...args.map(a => { const s = String(a); return s.length > 160 ? s.slice(0, 160) + `…(+${s.length - 160})` : s })]
  const joined = parts.join(' ')
  return joined.length > 1200 ? joined.slice(0, 1200) + '…' : joined
}

// ── event parsing (pure, unit-testable) ──────────────────────────────────────
// `opencode run --format json` emits NDJSON events. The ones we render:
//   {type:'step_start', sessionID}                     → session id (for -s resume)
//   {type:'reasoning',  part:{text}}                   → thinking
//   {type:'text',       part:{text}}                   → assistant output
//   {type:'step_finish',part:{tokens:{total}}}         → usage
//   {type:'error',      error:{data:{message}}}        → API error (e.g. 401)
export type OpencodeAction =
  | { kind: 'session'; id: string }
  | { kind: 'think'; text: string }
  | { kind: 'assistant'; text: string }

export function parseOpencodeEvent(obj: any): OpencodeAction[] {
  if (!obj || typeof obj !== 'object') return []
  const out: OpencodeAction[] = []
  if (obj.type === 'step_start' && typeof obj.sessionID === 'string') out.push({ kind: 'session', id: obj.sessionID })
  const text = obj.part?.text
  if (typeof text === 'string' && text) {
    if (obj.type === 'reasoning') out.push({ kind: 'think', text })
    else if (obj.type === 'text') out.push({ kind: 'assistant', text })
  }
  return out
}

// opencode's `--format json` streams the CUMULATIVE text of each part on every update (part.text is
// the full text so far, not a token delta), but onAssistantDelta/onLog expect an incremental delta.
// Return just the growth. The prefix check makes it safe either way: if a stream ever sends genuine
// deltas instead, `next` won't extend `prev` and we pass it through whole. Callers set prev = next.
export function opencodeDelta(prev: string, next: string): string {
  return next.startsWith(prev) ? next.slice(prev.length) : next
}

// Surface opencode API errors (401 key-inactive etc.) with their real nested message.
export function opencodeErrorMessage(obj: any): string | null {
  if (!obj || typeof obj !== 'object' || obj.type !== 'error') return null
  const e = obj.error
  return String(e?.data?.message ?? e?.message ?? e?.name ?? 'opencode error')
}

// Cumulative token usage from a step_finish event, else null.
export function opencodeUsage(obj: any): number | null {
  const total = obj?.type === 'step_finish' ? obj.part?.tokens?.total : undefined
  return typeof total === 'number' ? total : null
}

// `opencode models` prints one "provider/model" per line. Map to Model[] (id keeps the full
// provider/model so `-m` gets exactly what opencode expects).
export function parseOpencodeModels(stdout: string): Model[] {
  return stdout.split('\n').map(l => l.trim()).filter(l => l.includes('/'))
    .map(id => ({ id, label: id.split('/').slice(1).join('/') || id, description: id.split('/')[0] }))
}

export interface OpencodeSpec { bin?: string; defaultModels: Model[] }

export function makeOpencodeProvider(spec: OpencodeSpec): AgentProvider {
  const bin = spec.bin ?? 'opencode'
  const defaultModels: Model[] = spec.defaultModels ?? []
  const modelsFromCli = async (): Promise<Model[]> => {
    try { const { stdout } = await execa(bin, ['models']); return parseOpencodeModels(stdout) } catch { return [] }
  }
  // model id is "provider/model"; only pass -m for a real one (else opencode uses its default).
  const modelArgs = (model: string) => (model && model.includes('/') ? ['-m', model] : [])
  const baseArgs = (model: string, cwd: string) => ['run', '--format', 'json', '--thinking', ...modelArgs(model), '--dir', cwd]

  return {
    id: 'opencode',
    displayName: 'opencode',
    bin,
    capabilities: { structuredOutput: true, permissionHook: false, pty: false, mcpTools: false, liveModels: true },
    async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
    async listModels() { const m = await modelsFromCli(); return m.length ? m : defaultModels },
    async listModelsLive() { return modelsFromCli() },

    run(task: AgentTask, cb: AgentCallbacks, env): AgentSession {
      cb.onState('run')
      const scanner = createFenceScanner(p => cb.onHandoff?.(p))
      const args = [...baseArgs(task.model, task.cwd), task.prompt]
      const child = execa(bin, args, { cwd: task.cwd, env, reject: false, stdin: 'ignore' })
      let buf = ''
      let ctxMax = 0
      // part.text is cumulative (see opencodeDelta) — track per stream and feed only the growth to the
      // fence scanner, else every line re-appears with each snapshot and the log balloons.
      let prevAsst = ''
      let prevThink = ''
      const processLine = (raw: string) => {
        const line = raw.trim(); if (!line) return
        let obj: unknown
        try { obj = JSON.parse(line) } catch {
          const kept = scanner.feedLine(line); if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: 'info' }); return
        }
        const u = opencodeUsage(obj); if (u != null && u > ctxMax) { ctxMax = u; cb.onUsage?.({ used: ctxMax, window: contextWindowFor(task.model) }) }
        for (const a of parseOpencodeEvent(obj)) {
          if (a.kind === 'session') { cb.onSession?.(a.id); continue }
          const isThink = a.kind === 'think'
          const d = isThink ? opencodeDelta(prevThink, a.text) : opencodeDelta(prevAsst, a.text)
          if (isThink) prevThink = a.text; else prevAsst = a.text
          if (!d) continue
          const kept = d.split('\n').flatMap(l => scanner.feedLine(l))
          if (kept.length) cb.onLog({ ts: now(), text: kept.join('\n'), level: 'info', kind: isThink ? 'think' : 'output' })
        }
      }
      child.stdout?.on('data', (b: Buffer) => { buf += b.toString(); let nl: number; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); processLine(l) } })
      const done = child.then((res) => {
        processLine(buf); buf = ''
        const ok = res.exitCode === 0
        if (!ok) logError('opencode', `run 失败 · 退出码 ${res.exitCode}`, `cmd: ${clipArgs(bin, args)}\ncwd: ${task.cwd}`)
        cb.onState(ok ? 'ok' : 'err')
        const result = { ok, summary: ok ? '完成' : `退出码 ${res.exitCode}` }
        cb.onDone(result); return result
      }).catch((err) => {
        logError('opencode', 'run 异常', `${(err as Error)?.message ?? err}\ncmd: ${clipArgs(bin, args)}`)
        cb.onState('err'); cb.onError(err as Error); return { ok: false }
      })
      return { id: task.agentId, cancel: () => { child.kill('SIGTERM') }, done }
    },

    chat(task: ChatTask, cb: ChatCallbacks, env): AgentSession {
      // Resume the prior turn natively when we have a session id, so opencode sees full context.
      const sessionArgs = task.sessionId ? ['-s', task.sessionId] : []
      const directive = forgeChatDirective(env)
      const body = buildChatPrompt(task)
      const prompt = directive ? `${directive}\n\n${body}` : body
      const args = ['run', '--format', 'json', '--thinking', ...sessionArgs, ...modelArgs(task.model), '--dir', task.cwd, prompt]
      // Inactivity watchdog (not a hard wall-clock timeout): a long input that's actively streaming
      // must not be killed just for taking >180s. Fires only after real silence → no more spurious
      // "chat 无回复" on big prompts.
      const child = execa(bin, args, { cwd: task.cwd, env, reject: false, stdin: 'ignore' })
      const wd = makeIdleWatchdog(CHAT_IDLE_MS, () => { try { child.kill('SIGTERM') } catch { /* already gone */ } })
      const start = Date.now()
      let buf = ''
      let sawDelta = false
      let lastErr: string | null = null
      let rawErr = ''
      let ctxMax = 0
      // part.text is cumulative — track the last snapshot per stream and emit only the growth so the
      // renderer (which appends deltas) shows the reply once, not a pile-up of growing prefixes.
      let prevAsst = ''
      let prevThink = ''
      const cap = (s: string, add: string) => (s + add).slice(-2000)
      const handle = (obj: unknown) => {
        const err = opencodeErrorMessage(obj); if (err) lastErr = err
        const u = opencodeUsage(obj); if (u != null && u > ctxMax) { ctxMax = u; cb.onUsage?.({ used: ctxMax, window: contextWindowFor(task.model) }) }
        for (const a of parseOpencodeEvent(obj)) {
          if (a.kind === 'session') cb.onSession(a.id)
          else if (a.kind === 'assistant') { sawDelta = true; const d = opencodeDelta(prevAsst, a.text); prevAsst = a.text; if (d) cb.onAssistantDelta(d) }
          else if (a.kind === 'think') { const d = opencodeDelta(prevThink, a.text); prevThink = a.text; if (d) cb.onThinkDelta(d) }
        }
      }
      const processLine = (raw: string) => { const line = raw.trim(); if (!line) return; try { handle(JSON.parse(line)) } catch { /* non-JSON banner */ } }
      child.stdout?.on('data', (b: Buffer) => { wd.beat(); buf += b.toString(); let nl: number; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); processLine(l) } })
      child.stderr?.on('data', (b: Buffer) => { wd.beat(); rawErr = cap(rawErr, b.toString()) })
      const done = child.then((res) => {
        wd.clear()
        processLine(buf); buf = ''
        if (!sawDelta) {
          let diag = lastErr ?? ''
          if (!diag && (wd.firedFlag || res.timedOut)) diag = 'opencode 长时间无响应（240s 无任何输出）已终止 —— 可尝试拆分过长的输入或检查网络'
          if (!diag && rawErr.trim()) diag = `opencode stderr:\n${rawErr.trim()}`
          if (!diag) diag = `opencode 无输出 (退出码 ${res.exitCode})`
          cb.onError(new Error(diag))
          logError('opencode', 'chat 无回复', `cmd: ${clipArgs(bin, args)}\ncwd: ${task.cwd}\n${diag}`)
        } else if (res.exitCode !== 0) {
          logError('opencode', `chat 退出码 ${res.exitCode}`, [`cmd: ${clipArgs(bin, args)}`, rawErr.trim() ? `stderr: ${rawErr.trim()}` : ''].filter(Boolean).join('\n'))
        }
        const elapsed = Math.round((Date.now() - start) / 1000)
        cb.onDone({ elapsed })
        return { ok: res.exitCode === 0, summary: res.exitCode === 0 ? '完成' : `退出码 ${res.exitCode}` }
      }).catch((err) => {
        wd.clear()
        logError('opencode', 'chat 异常', `${(err as Error)?.message ?? err}\ncmd: ${clipArgs(bin, args)}`)
        cb.onError(err as Error); return { ok: false }
      })
      return { id: task.id, cancel: () => { wd.clear(); child.kill('SIGTERM') }, done }
    },
  }
}
