import { appendMessage } from '../chat/chatStore'
import { readSessions } from '../chat/sessionStore'
import { readChangesMulti } from '../git/changes'
import { buildNarration, buildStageNote, pickMainAgent, statusZh } from './narration'
import type { AgentProvider } from '../agents/types'
import type { ChatEvent, ChatMessage, EngineEvent, RunState } from '@shared/types'

export interface NarratorDeps {
  providers: Record<string, AgentProvider>
  env: () => NodeJS.ProcessEnv
  emit: (e: ChatEvent) => void
  proxy: () => string
}

let seq = 0
function mkId() { return `n-${Date.now()}-${++seq}` }
function now() { return new Date().toISOString().slice(11, 19) }
function activeSessionId(wsPath: string) { return readSessions(wsPath).activeSessionId }

export class NarratorService {
  private started = new Set<string>()
  private done = new Set<string>()
  // runId -> set of stage keys already narrated (deterministic per-stage回流, independent of start/done)
  private narratedStages = new Map<string, Set<string>>()
  constructor(private deps: NarratorDeps) {}

  onEngineEvent(e: EngineEvent): void {
    if (e.type !== 'run:update') return
    const run = e.run
    try {
      // Deterministic (zero-LLM) per-stage回流: a stage transitioning to ok/err is narrated once,
      // reusing the handoff/error log lines the orchestrator already pushed into agent.logs.
      this.narrateStages(run)
      if (run.status === 'run' && run.stages.some(s => s.agents.length > 0) && !this.started.has(run.id)) {
        this.started.add(run.id)
        void this.narrate('start', run).catch(() => {})
      }
      if ((run.status === 'ok' || run.status === 'err') && !this.done.has(run.id)) {
        this.done.add(run.id)
        void this.narrate('done', run).catch(() => {})
      }
    } catch { /* never throw into the bus */ }
  }

  // Append one deterministic note per stage as it reaches a terminal state. No provider.chat call.
  // The note text contains agent-produced (untrusted) handoff summaries — it is stored/emitted as
  // plain text only; the renderer escapes it via React. Never build HTML here.
  private narrateStages(run: RunState): void {
    let seen = this.narratedStages.get(run.id)
    if (!seen) { seen = new Set(); this.narratedStages.set(run.id, seen) }
    for (const stage of run.stages) {
      if (stage.state !== 'ok' && stage.state !== 'err') continue
      if (seen.has(stage.key)) continue
      seen.add(stage.key)
      const text = buildStageNote(stage)
      const msg: ChatMessage = {
        id: mkId(), who: 'ai', text, model: '系统', ts: now(),
        think: { label: '阶段进展', steps: [text] },
        // Carry the stage's design docs onto this durable message so the timeline keeps an openable
        // link after the design-gate card is resolved and unmounts (fixes: doc becomes plain text).
        ...(stage.docs?.length ? { docs: stage.docs } : {})
      }
      const sid = activeSessionId(run.workspacePath)
      appendMessage(run.workspacePath, sid, msg)
      this.deps.emit({ workspacePath: run.workspacePath, sessionId: sid, type: 'done', message: msg })
    }
  }

  private async narrate(kind: 'start' | 'done', run: RunState): Promise<void> {
    const { emit, env, proxy } = this.deps
    const main = pickMainAgent(run, this.deps.providers)
    if (!main) return
    // Aggregate diffs across ALL run projects (fall back to the workspace dir if none).
    const cwds = run.projects.length ? run.projects.map(p => p.cwd) : [run.workspacePath]
    const multi = kind === 'done'
      ? await readChangesMulti(cwds, proxy()).catch(() => ({ total: 0, add: 0, del: 0, byProject: [] }))
      : { total: 0, add: 0, del: 0, byProject: [] as { cwd: string; changes: import('@shared/types').ChangeItem[] }[] }
    // Keep buildNarration fed with the flattened ChangeItem list — LLM prompt unchanged.
    const changes = multi.byProject.flatMap(p => p.changes)
    const prompt = buildNarration(kind, run, changes)
    const id = mkId()
    const label = `${main.providerDisplay} · 转述`
    const wp = run.workspacePath
    const sid = activeSessionId(wp)
    emit({ workspacePath: wp, sessionId: sid, type: 'assistant-start', id, model: label })
    let text = ''
    await new Promise<void>((resolve) => {
      main.provider.chat!({ id, prompt, model: main.model, cwd: wp }, {
        onSession() {},
        onThinkDelta() {},
        onAssistantDelta: (t) => { text += t; emit({ workspacePath: wp, sessionId: sid, type: 'assistant-delta', id, text: t }) },
        onDone: () => {
          const msg: ChatMessage = {
            id, who: 'ai', text, model: label, ts: now(),
            think: { label: '编排回顾', steps: run.stages.map(s => `${s.name} · ${statusZh(s.state)}`) },
            ...(kind === 'done' ? { changes: { total: multi.total, add: multi.add, del: multi.del } } : {})
          }
          appendMessage(wp, sid, msg)
          emit({ workspacePath: wp, sessionId: sid, type: 'done', message: msg })
          resolve()
        },
        onError: (err) => { emit({ workspacePath: wp, sessionId: sid, type: 'error', id, error: err.message }); resolve() }
      }, env())
    })
  }
}
