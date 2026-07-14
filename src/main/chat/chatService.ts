import { existsSync } from 'node:fs'
import { appendMessage, readMessages, readSession, readWatermark, writeSession, writeWatermark } from './chatStore'
import type { AgentProvider, AgentSession, ConfirmReq } from '../agents/types'
import type { ChatSendPayload, ChatMessage, ChatEvent, SubagentCard } from '@shared/types'
import { createRunFenceScanner } from '../agents/runFence'
import { buildMemoryPreamble } from './memory/preamble'
import { buildContinuationPreamble, buildLocalHistoryPreamble } from './continuation'
import { distillSession, promoteToWorkspace, type DistillDeps } from './memory/distiller'
import { distillModelFor } from './memory/distillModel'
import { estimateMessagesTokens, SESSION_DISTILL_THRESHOLD } from './memory/tokenEstimate'
import { discoverAgentContext, extractRuntimeContext, forgeMcpContext, mergeAgentContext, mentionedSkills } from '../agents/contextMeta'
import { readInstalledSkills } from '../skills/installedSkills'
import { getSession } from './sessionStore'
import { providerSupportsResume } from '../agents/resumeSupport'
import { logDebug } from '../log/appLog'
import { perfSpan } from '../perf/perfSpans'

export interface SendTurnDeps {
  provider: AgentProvider
  env: NodeJS.ProcessEnv
  emit: (e: ChatEvent) => void
  confirm?: (req: ConfirmReq) => Promise<'allow' | 'deny'>
  onRunTrigger?: (workspacePath: string, task: string) => void
  onSessionStart?: (session: AgentSession) => void
}

let seq = 0
function mkId(prefix: string) { return `${prefix}-${Date.now()}-${++seq}` }
// Full ISO timestamp (UTC instant) — the renderer formats it to LOCAL time + date. (Older builds stored a
// UTC clock-only "HH:MM:SS", which showed the wrong timezone and carried no date; this fixes both.)
function now() { return new Date().toISOString() }

export function history(wsPath: string, sessionId: string): ChatMessage[] { return readMessages(wsPath, sessionId) }

// Installed skills (incl. home/plugin, e.g. superpowers) cached for the session — used to flag skills
// the agent names in its reply. Skills change rarely, so a one-time scan is fine.
let _skillsCache: { name: string; path: string }[] | null = null
function cachedInstalledSkills(): { name: string; path: string }[] {
  if (!_skillsCache) _skillsCache = readInstalledSkills(undefined, true).map(s => ({ name: s.name, path: s.path }))
  return _skillsCache
}

export function sendTurn(payload: ChatSendPayload, deps: SendTurnDeps): Promise<ChatMessage> {
  return perfSpan('chat', 'sendTurn', () => {
    const { provider, env, emit } = deps
    const ws = payload.workspacePath
    const sid = payload.sessionId
    const label = `${payload.agentLabel} · ${payload.model}`
    let context = mergeAgentContext(discoverAgentContext(ws, ws), forgeMcpContext(env))

    // 原生续聊：续自导入会话、同源同代理、该 provider 真的传 --resume、还没拿到新 resumeId、原 cwd 仍在
    // → 用原会话 id 让 CLI 原生 resume（完整上下文），跳过文本摘要 preamble。
    const meta = getSession(ws, sid)
    const cont = meta?.continuedFrom
    const nativeResumeId = (cont
      && payload.agent === cont.source
      && providerSupportsResume(payload.agent)
      && readSession(ws, sid, payload.agent) === undefined
      && existsSync(ws))
      ? cont.externalId
      : undefined

    // Three-branch context-continuity selection for the ACTIVE provider (payload.agent) in this session:
    //   1. No native session yet for this provider (first turn with it, or a non-chat `run()` provider,
    //      which never gets a native session) → full local history preamble.
    //   2. Has a native session, but its watermark is behind the session's latest message count (the
    //      user switched away and back while another provider ran turns in between) → INCREMENTAL
    //      preamble covering only what it missed; it still resumes its own native session for its own
    //      continuity, this just bridges the gap left by other providers.
    //   3. Has a native session and is caught up → no preamble (fast path, unchanged).
    // `latest` must be read BEFORE this turn's user message is appended below, so it reflects prior
    // conversation history only (not double-counting the message we're about to add).
    const hasSession = provider.chat ? readSession(ws, sid, payload.agent) !== undefined : false
    const watermark = readWatermark(ws, sid, payload.agent)
    const latest = readMessages(ws, sid).length
    const gapped = nativeResumeId ? false : !hasSession
    const preamble = buildMemoryPreamble(ws, sid, { resumeGapped: gapped })
    // Imported sessions re-feed the external transcript; in-app sessions (provider switch, e.g.
    // qoder→codex) fall back to Forge's own stored messages so the new CLI keeps prior context.
    let contPre = ''
    if (nativeResumeId) {
      contPre = buildContinuationPreamble(ws, sid)
    } else if (!hasSession) {
      contPre = buildLocalHistoryPreamble(ws, sid)
    } else if (watermark < latest) {
      contPre = buildLocalHistoryPreamble(ws, sid, {}, { fromIndex: watermark })
    }
    const promptText = [contPre, preamble, payload.text].filter(Boolean).join('\n')

    const userMsg: ChatMessage = {
      id: mkId('u'), who: 'user', text: payload.text,
      files: payload.attachments.length ? payload.attachments : undefined, ts: now()
    }
    appendMessage(ws, sid, userMsg)
    emit({ workspacePath: ws, sessionId: sid, type: 'user', message: userMsg })

    const aid = mkId('a')
    emit({ workspacePath: ws, sessionId: sid, type: 'assistant-start', id: aid, model: label, context })
    let text = ''
    let think = ''
    let lastUsage: { used: number; window: number } | undefined
    // Built-in Task sub-agents spawned this turn, keyed by tool_use id — accumulated live and persisted
    // on the finished message so their cards survive reload.
    const subagents = new Map<string, SubagentCard>()
    const subagentList = () => (subagents.size ? [...subagents.values()] : undefined)
    const onSubagent = (ev: { id: string; phase: 'start' | 'update' | 'done'; subagentType?: string; description?: string; prompt?: string; result?: string; isError?: boolean }) => {
      const prev = subagents.get(ev.id) ?? { id: ev.id, state: 'running' as const }
      const next: SubagentCard = {
        ...prev,
        subagentType: ev.subagentType ?? prev.subagentType,
        description: ev.description ?? prev.description,
        prompt: ev.prompt ?? prev.prompt,
        result: ev.result ?? prev.result,
        state: ev.phase === 'done' ? (ev.isError ? 'error' : 'done') : prev.state,
      }
      subagents.set(ev.id, next)
      emit({ workspacePath: ws, sessionId: sid, type: 'subagent', id: aid, sub: next })
    }
    // Distillation runs on THIS session's provider. Pick a model valid for it: claude gets the cheap
    // 'haiku-4.5' alias; every other provider falls back to the session's own model (its account
    // default) — feeding a claude-only alias to codex/cursor 400s (model-not-supported).
    const distillModel = distillModelFor(payload.agent) ?? payload.model
    const oneShot: DistillDeps['oneShot'] = (prompt) => new Promise<string>((resolve, reject) => {
      if (!provider.chat) { resolve(''); return }
      let acc = ''
      provider.chat({ id: mkId('distill'), prompt, model: distillModel, cwd: ws }, {
        onSession: () => {},
        onAssistantDelta: (t) => { acc += t },
        onThinkDelta: () => {},
        onDone: () => resolve(acc),
        onError: (err) => reject(err),
      }, env)
    })
    const scheduleDistill = () => {
      const deps: DistillDeps = { oneShot }
      if (estimateMessagesTokens(readMessages(ws, sid)) > SESSION_DISTILL_THRESHOLD) void distillSession(ws, sid, deps)
      void promoteToWorkspace(ws, sid, deps)
    }
    // On a SUCCESSFUL turn, advance this provider's watermark to the session's new message count — its
    // native session (if any) now covers everything through this exchange, so a future switch-back only
    // needs to bridge from here. Only meaningful for chat() providers (the only ones that get a native
    // session). Deliberately NOT called on error/abort: the turn may have failed before the provider
    // absorbed the injected context, so advancing the watermark would let a later switch-back see
    // wm >= latest → skip the preamble → silently lose that context with no recovery. Leaving it at the
    // last successful value re-triggers the incremental catch-up next time (a little overlap is fine).
    const bumpWatermark = () => { if (provider.chat) writeWatermark(ws, sid, payload.agent, readMessages(ws, sid).length) }
    const finishOk = (elapsed?: number): ChatMessage => {
      // Fold in skills the agent explicitly NAMED in its reply (home/plugin skills the workspace scan +
      // path-regex miss, e.g. superpowers/brainstorming) so the context panel reflects what it used.
      context = mergeAgentContext(context, { skills: mentionedSkills(text + '\n' + think, cachedInstalledSkills()), rules: [], mcps: [] })
      // Scan the full assistant text for a forge:run fence: strip it from the displayed text and,
      // if a valid task was found, trigger the workspace's configured workflow run.
      const trigger: { task: string | null } = { task: null }
      const scanner = createRunFenceScanner((t) => { trigger.task = t })
      const cleanedLines: string[] = []
      for (const line of text.split('\n')) cleanedLines.push(...scanner.feedLine(line))
      cleanedLines.push(...scanner.flush())
      const cleaned = cleanedLines.join('\n')
      dbgFinal(cleaned)

      const steps = think.split('\n').map(s => s.trim()).filter(Boolean)
      const msg: ChatMessage = {
        id: aid, who: 'ai', text: cleaned, model: label, provider: payload.agent, ts: now(),
        think: steps.length ? { label: '已思考', elapsed, steps } : undefined,
        context,
        usage: lastUsage,
        subagents: subagentList(),
      }
      appendMessage(ws, sid, msg)
      bumpWatermark()
      emit({ workspacePath: ws, sessionId: sid, type: 'done', message: msg })
      if (trigger.task) deps.onRunTrigger?.(ws, trigger.task)
      scheduleDistill()
      return msg
    }
    const finishErr = (err: Error): ChatMessage => {
      emit({ workspacePath: ws, sessionId: sid, type: 'error', id: aid, error: err.message })
      const msg: ChatMessage = { id: aid, who: 'ai', text: text || `错误: ${err.message}`, model: label, provider: payload.agent, ts: now(), subagents: subagentList() }
      appendMessage(ws, sid, msg)
      scheduleDistill()
      return msg
    }
    const finishAborted = (): ChatMessage => {
      const msg: ChatMessage = { id: aid, who: 'ai', text, model: label, provider: payload.agent, ts: now(), subagents: subagentList() }
      appendMessage(ws, sid, msg)
      emit({ workspacePath: ws, sessionId: sid, type: 'done', message: msg })
      scheduleDistill()
      return msg
    }

    let aborted = false
    // Diagnostic: capture the raw shape of the assistant deltas (revealing whitespace/newlines) so a
    // "one char/word per line" garble can be traced to the exact stream chunks. Bounded per turn; open
    // 设置 → 调试日志 to read. `via` shows which path emitted it (chat=native stream, run=log fallback).
    let dbgN = 0
    const dbgDelta = (via: string, t: string) => { if (dbgN < 40) { logDebug('chat', `Δ#${dbgN} ${payload.agent}/${via}`, JSON.stringify(t)); dbgN++ } }
    const dbgFinal = (t: string) => logDebug('chat', `final ${payload.agent} len=${t.length}`, JSON.stringify(t.slice(0, 400)))
    const wrapSession = (session: AgentSession): AgentSession => ({
      id: session.id,
      done: session.done,
      cancel: () => { aborted = true; session.cancel() },
    })

    if (provider.chat) {
      const sessionId = nativeResumeId ?? readSession(ws, sid, payload.agent)
      return new Promise<ChatMessage>((resolve) => {
        // Guard: a provider may fire BOTH onError and onDone at end-of-turn (e.g. an API error with no
        // assistant text). Only the first settles — otherwise finishOk (empty text) overwrites
        // finishErr's error bubble, leaving a blank reply.
        let settled = false
        const session = provider.chat!({ id: aid, prompt: promptText, model: payload.model, cwd: ws, sessionId, attachments: payload.attachments, permissionMode: payload.permissionMode }, {
          onSession: (id) => writeSession(ws, sid, payload.agent, id),
          onAssistantDelta: (t) => { dbgDelta('chat', t); text += t; emit({ workspacePath: ws, sessionId: sid, type: 'assistant-delta', id: aid, text: t }) },
          onThinkDelta: (t) => {
            think += (think ? '\n' : '') + t
            const before = context.skills.length + context.rules.length + (context.mcps?.length ?? 0)
            context = mergeAgentContext(context, extractRuntimeContext(t, ws))
            const after = context.skills.length + context.rules.length + (context.mcps?.length ?? 0)
            emit({ workspacePath: ws, sessionId: sid, type: 'think-delta', id: aid, text: t, context: after !== before ? context : undefined })
          },
          // Raw startup/runtime logs → live think steps, but NOT accumulated into `think`: they're
          // ephemeral liveness (visible while the turn runs, replaced by the final message on done), so
          // the persisted reasoning stays clean while the spawn/handshake gap no longer looks frozen.
          onStatus: (t) => emit({ workspacePath: ws, sessionId: sid, type: 'think-delta', id: aid, text: t }),
          onConfirm: deps.confirm,
          onUsage: (u) => { lastUsage = u },
          onSubagent,
          onDone: (r) => { if (settled) return; settled = true; resolve(finishOk(r.elapsed)) },
          onError: (err) => { if (settled) return; settled = true; resolve(aborted ? finishAborted() : finishErr(err)) },
        }, env)
        deps.onSessionStart?.(wrapSession(session))
      })
    }

    return new Promise<ChatMessage>((resolve) => {
      const session = provider.run(
        { stageKey: 'chat', agentId: aid, name: 'chat', prompt: promptText, cwd: ws, model: payload.model },
        {
          onLog: (l) => { if (l.level === 'ok' || (l.level === 'accent' && (l.kind === 'output' || l.kind == null))) { dbgDelta('run', l.text); text += (text ? '\n' : '') + l.text; emit({ workspacePath: ws, sessionId: sid, type: 'assistant-delta', id: aid, text: l.text }) } },
          onState: () => {},
          onConfirm: deps.confirm ?? (async () => 'deny'),
          onInput: async () => '',
          onDone: () => {},
          onError: (err) => resolve(aborted ? finishAborted() : finishErr(err))
        }, env
      )
      deps.onSessionStart?.(wrapSession(session))
      session.done.then(() => resolve(finishOk(undefined))).catch((err) => resolve(aborted ? finishAborted() : finishErr(err as Error)))
    })
  })
}
