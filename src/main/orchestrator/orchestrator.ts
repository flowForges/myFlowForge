import { EventBus } from './eventBus'
import { RunStore } from './runStore'
import type { AgentProvider, AgentCallbacks, AgentSession } from '../agents/types'
import { buildAgentEnv } from '../agents/env'
import type { RunState, StageRuntime, AgentRuntime, PendingAction } from '@shared/types'
import { startBridge, type ForgeBridge } from '../mcp/forgeBridge'
import { buildStagePrompt, buildPluginPrompt, type HandoffBrief } from './brief'
import { weavePlugins } from './pluginWeave'
import { buildGateBody, outputFromLogs, pickDocArtifact, buildDesignDocs, gateBodyFromDoc, type DesignDoc } from './gateBody'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { claudeAllowedTools } from '../agents/pluginTools'
import type { Plugin } from '../../shared/plugin'
import { Heartbeater, type HeartbeatConfig, type HeartbeatEffect } from './heartbeat'
import { buildReviewTasks, type ReviewerTask } from './reviewTasks'
import type { ReviewConfig, ReviewLens, StageKey } from '../config/schema'
import { discoverAgentContext, forgeMcpContext, mergeAgentContext } from '../agents/contextMeta'
import { executeHook } from './executeHook'
import { runExplain } from './explain'

// Forge tools a working stage sub-agent legitimately needs. EXCLUDES forge_propose_plan:
// the orchestrator bridge ctx doesn't implement proposePlan, and a stage agent that tries to
// propose (because the auto-discovered forge-workflow skill told it to) would error and fall
// back to a confusing forge:run fence. Restricting the toolset means stage agents never even
// see the propose tool. Tool names mirror ALL_TOOLS in mcp/forgeMcp.ts (minus forge_propose_plan).
export const STAGE_FORGE_TOOLS = 'forge_read_context,forge_write_artifact,forge_ask,forge_handoff,forge_heartbeat'

// Stages that, on successful completion, PAUSE the run for a human review/approval before the
// next stage runs (inter-stage hard gate). v1: only 'design' (技术方案设计) — the user must
// approve the technical design before development proceeds. Reject stops the whole run.
// Defined as a set so it's trivial to extend to other stages later.
// Stages that, by DEFAULT (no explicit spec.gate), pause on a hard review gate after completing.
// Exported so resume logic can tell a gated stage that finished-but-was-never-approved apart from one
// that's genuinely done. The fallback stays design-only for back-compat; every-stage gating is opt-in
// per stage via spec.gate === true (the workspace→run mapping sets it so the user reviews every stage,
// and #3's per-stage config will drive it). A stage may also opt OUT via spec.gate === false.
export const REVIEW_GATED_STAGES = new Set(['design'])
// Whether a stage pauses on a review gate after completing: explicit spec.gate wins; otherwise the
// built-in default set above. Used by resume logic; the run loop additionally folds in an isLast rule
// for the FALLBACK case (see the gate site) so a bare design-last stage still doesn't self-gate.
export function stageGated(spec: StageSpec): boolean {
  return spec.gate ?? REVIEW_GATED_STAGES.has(spec.key)
}
// Context key marking that a gated stage's review gate was APPROVED (not cancelled/denied). Resume
// reads this to avoid skipping past an un-approved design straight into code.
export const gateApprovedKey = (stageKey: string) => 'gate-approved:' + stageKey

export type StageScope = 'root' | 'per-project'
// `projects` (by name) optionally scopes a PER-PROJECT stage to a subset of the run's projects — e.g.
// analyze all 5 projects but develop only 2. Absent/empty = every project. Ignored for root stages.
// gate: override the default review-gate behavior for this stage (see stageGated). reworkNote:
// set by the rework loop when the user 打回重做 — carries their revision direction into the re-run.
// summary: after per-project runs, append a 汇总 agent (design's cross-project consolidation). projectAgent:
// use each project's own provider/model (develop). producesDoc: force a markdown deliverable (design). All
// default (per built-in key) via the config helpers; custom stages set them explicitly.
export interface StageSpec { key: string; name: string; provider: string; model: string; scope?: StageScope; review?: ReviewConfig; prompt?: string; projects?: string[]; gate?: boolean; reworkNote?: string; summary?: boolean; projectAgent?: boolean; producesDoc?: boolean }

// Where a stage's agent(s) are spawned:
//  - 'root'        → one agent in the workspace root
//  - 'per-project' → one agent per project, each in its project worktree, so it loads
//                    that project's project-level skills/rules.
// `develop` MUST be per-project (it edits project code); `design` defaults to per-project
// (so it can read each project's skills/rules); the rest stay at the workspace root.
// An explicit `spec.scope` overrides the default.
const DEFAULT_STAGE_SCOPE: Record<string, StageScope> = { develop: 'per-project', design: 'per-project' }
export function stageScope(spec: StageSpec): StageScope { return spec.scope ?? DEFAULT_STAGE_SCOPE[spec.key] ?? 'root' }
export interface DevelopProject { name: string; cwd: string; provider?: string; model?: string }
export interface StartRunOpts {
  runId: string
  workspaceName: string
  workspacePath: string
  // The chat session that owns this run — surfaced on RunState so the renderer scopes the run + its
  // gate cards to that session's tab (see RunState.sessionId). Optional: direct/legacy runs omit it.
  sessionId?: string
  stages: StageSpec[]
  developProjects: DevelopProject[]
  task?: string   // seeds the first (requirement) stage's prompt; from the user's first chat message
  plugins?: Plugin[]   // workflow-scope plugins (hook micro-agents) woven between stages by `after`
  // step-scope plugins, keyed by `after`. Only `after === '__wf'` (工作流完成后) is executed here —
  // at the END of startRun, after all stages, skipped on cancel. `__basic`/`__proj` (run during
  // workspace creation) are DEFERRED to a follow-up (see runHook callsite note).
  stepPlugins?: Plugin[]
  // Resume of a cancelled/failed run: `stages` holds ONLY the remaining stages. `completedStages`
  // is replayed into the run (so the UI shows them done) and `priorBriefs` seeds this.briefs so the
  // remaining stages inherit prior context — provider-agnostic, which is what enables cross-model resume.
  resume?: { completedStages: StageRuntime[]; priorBriefs: HandoffBrief[] }
  workflowId?: string
  workflowName?: string
  // Permission shield from the initiating chat session; passed to every stage sub-agent's run() so the
  // shield governs stage agents too (not just the main chat agent). Absent → provider default ('auto').
  permissionMode?: import('@shared/permissions').PermissionMode
}
export interface OrchestratorOpts {
  bus: EventBus
  providers: Record<string, AgentProvider>
  proxy: () => string
  mcpEntry?: string
  heartbeat?: HeartbeatConfig
  now?: () => number
  makeInterval?: (fn: () => void, ms: number) => { clear(): void }
  // How many times to re-run ONLY the failed projects of a per-project stage before failing it. Default 1.
  projectRetries?: number
}

export class Orchestrator {
  private bus: EventBus
  private providers: Record<string, AgentProvider>
  private proxy: () => string
  private mcpEntry: string | undefined
  private run!: RunState
  private pendingSeq = 0
  // Per-agent cwd (its project worktree, or the workspace root for root/summary agents). Recorded at
  // task start so the design gate can build openable doc refs {path, cwd} for the file viewer.
  private agentCwd = new Map<string, string>()
  private resolvers = new Map<string, (value: { decision: 'allow' | 'deny' | 'modify'; value?: string; choice?: number }) => void>()
  private store: RunStore | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private bridge: ForgeBridge | null = null
  private briefs: HandoffBrief[] = []
  private task?: string
  private permissionMode?: import('@shared/permissions').PermissionMode
  private activeSessions = new Set<import('../agents/types').AgentSession>()
  private cancelled = false
  private now: () => number
  private makeInterval: (fn: () => void, ms: number) => { clear(): void }
  private hbCfg: HeartbeatConfig
  private projectRetries!: number
  private heartbeater: Heartbeater | null = null
  private hbTimer: { clear(): void } | null = null

  constructor(opts: OrchestratorOpts) {
    this.bus = opts.bus
    this.providers = opts.providers
    this.proxy = opts.proxy
    this.mcpEntry = opts.mcpEntry
    this.now = opts.now ?? (() => Date.now())
    this.makeInterval = opts.makeInterval ?? ((fn, ms) => {
      const id = setInterval(fn, ms)
      id.unref?.()
      return { clear: () => clearInterval(id) }
    })
    // Silence = NO stdout byte at all (onActivity beats on any byte). A single big LLM turn — e.g. the
    // Design stage scanning several projects with a large context on a slow/thinking model — legitimately
    // produces no output for minutes while it waits for the model, and killing it there yields a WRONG,
    // partial plan (worse than waiting). So warn at 2min but only kill after 6min of total silence, which
    // still catches a genuinely hung process (silent forever) without false-killing slow-but-live turns.
    this.hbCfg = opts.heartbeat ?? { stallMs: 120_000, killGraceMs: 240_000, pingMs: 15_000 }
    this.projectRetries = opts.projectRetries ?? 1
  }

  resolve(payload: { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; choice?: number }) {
    const r = this.resolvers.get(payload.id)
    if (r) {
      this.resolvers.delete(payload.id)
      this.run.pending = this.run.pending.filter(p => p.id !== payload.id)
      this.bus.emit({ type: 'pending:resolve', id: payload.id })
      r({ decision: payload.decision, value: payload.value, choice: payload.choice })
    }
  }

  // #6: run the user's rework feedback THROUGH the main agent (the run's provider) before it reaches the
  // execution sub-agent. The user interacts with the MAIN agent, which analyzes the feedback against the
  // task + this stage's output, keeps it on-theme, and produces a focused rework directive — instead of
  // the raw user words going straight to the sub-agent ("一切先过主代理"). Falls back to the raw feedback
  // if the run's provider has no chat() or the analysis fails, so a rework never gets blocked.
  private async analyzeRework(spec: StageSpec, stageOutput: string, feedback: string): Promise<string> {
    const fallback = feedback || '(用户要求返工,但未填写具体方向——请自查上一版最薄弱处并改进,重新给出一版。)'
    const provider = this.providers[spec.provider]
    if (!provider?.chat || this.cancelled) return fallback
    const prompt = [
      '你是本次工作流的【主代理】,负责在用户与执行子代理之间做分析与分派。用户对某个阶段的产出提出了反馈/打回,',
      '请先分析用户的真实意图,再把它转化为给子代理的清晰返工指令——绝不能脱离总任务主旨。只输出指令本身。',
      '',
      `# 总任务\n${this.task ?? '(未提供)'}`,
      `# 刚完成的阶段\n「${spec.name}」`,
      `# 该阶段本版产出(摘要)\n${(stageOutput || '(无摘要)').slice(0, 4000)}`,
      `# 用户的反馈/打回意见\n${feedback || '(用户未填写具体方向)'}`,
      '',
      '# 你要输出的返工指令(交给子代理执行,不要复述用户原话、不要寒暄)',
      '包含: 1) 用户真正想解决的核心问题(你的判断) 2) 具体要改的点 3) 必须保持不变、守住主旨的部分。',
    ].join('\n')
    let session: AgentSession | undefined
    try {
      const out = await new Promise<string>((resolve, reject) => {
        let acc = ''
        session = provider.chat!(
          { id: `rework-analyze-${spec.key}-${this.now()}`, prompt, model: spec.model, cwd: this.run.workspacePath },
          { onSession: () => {}, onAssistantDelta: (t) => { acc += t }, onThinkDelta: () => {}, onDone: () => resolve(acc), onError: reject },
          buildAgentEnv({ proxy: this.proxy() }),
        )
        if (session) this.activeSessions.add(session)
      })
      const directive = out.trim()
      if (!directive) return fallback
      return `【主代理已分析用户反馈,以下是返工指令】\n${directive}\n\n【用户原始反馈(供参考)】\n${feedback || '(未填写)'}`
    } catch { return fallback }
    finally { if (session) this.activeSessions.delete(session) }
  }

  private raise(action: PendingAction): Promise<{ decision: 'allow' | 'deny' | 'modify'; value?: string; choice?: number }> {
    // 打 ISO 时间戳(用可注入的 this.now()),让卡片能与聊天消息按时间在对话流里归并排序。
    const stamped: PendingAction = action.ts ? action : { ...action, ts: new Date(this.now()).toISOString() }
    this.run.pending.push(stamped)
    this.bus.emit({ type: 'pending:add', action: stamped })
    return new Promise(res => this.resolvers.set(action.id, res))
  }

  // Unblock every agent still awaiting a confirm/input so a finished or failed run never leaks a
  // suspended coroutine. Outstanding requests are auto-denied (the run is over — no user will answer).
  private drainPending() {
    for (const [id, r] of this.resolvers) { r({ decision: 'deny' }); this.bus.emit({ type: 'pending:resolve', id }) }
    this.resolvers.clear()
    this.run.pending = []
  }

  // Trailing 100ms throttle on run:update so per-token log streaming can't flood IPC and
  // re-render the agent tree per line. While the run is active, log-driven updates coalesce
  // to ~one emit / 100ms; state changes, terminal status (ok/err), and any flushNow=true
  // caller emit immediately so the UI reflects completion instantly. This is SEPARATE from
  // persist()'s own 300ms snapshot throttle (kept intact).
  private update(flushNow = false) {
    if (flushNow || this.run.status !== 'run') {
      if (this.updateTimer) { clearTimeout(this.updateTimer); this.updateTimer = null }
      this.bus.emit({ type: 'run:update', run: this.run }); this.persist(); return
    }
    if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null
        this.bus.emit({ type: 'run:update', run: this.run }); this.persist()
      }, 100)
    }
  }

  // Append a log line to an agent, capping retained history at the most recent 200 lines
  // (keep the tail, including the final result line) so long runs can't bloat memory or
  // the persisted snapshot.
  private pushLog(agent: AgentRuntime, line: AgentRuntime['logs'][number]) {
    agent.logs.push(line)
    if (agent.logs.length > 200) agent.logs.splice(0, agent.logs.length - 200)
  }

  // Throttled snapshot persist (trailing 300ms); terminal status flushes synchronously
  // so app quit right after a run ends can't lose the final state. Persist is a side
  // channel: failures are logged, never thrown into run control flow.
  private persist() {
    if (!this.store) return
    if (this.run.status === 'ok' || this.run.status === 'err') {
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
      this.flush()
    } else if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => { this.persistTimer = null; this.flush() }, 300)
    }
  }
  private flush() {
    try { this.store?.saveState(this.run) } catch (err) { console.warn('run state persist failed', err) }
  }

  getRun(): RunState | null { return this.run ?? null }

  // '终止退出': drop a terminal (err/ok) run so nothing offers to resume it. Refuses to touch a run
  // that's still executing (use cancel() for that first). Emits run:cleared so the renderer wipes its
  // run/pending state. Returns whether the in-memory run was cleared.
  clearRun(wsPath: string): boolean {
    const r = this.run
    if (r && r.workspacePath === wsPath && r.status !== 'run') {
      this.run = undefined as unknown as RunState
      this.bus.emit({ type: 'run:cleared', workspacePath: wsPath })
      return true
    }
    return false
  }

  cancel(reason = '已取消'): void {
    if (!this.run || this.run.status !== 'run') return
    this.cancelled = true
    this.hbTimer?.clear(); this.hbTimer = null
    // Mark agents/stages err before signalling sessions, so state is consistent
    // even if a session.cancel() synchronously fires a callback.
    for (const stage of this.run.stages) {
      for (const a of stage.agents) {
        if (a.state === 'run' || a.state === 'wait') {
          a.state = 'err'
          this.pushLog(a, { ts: new Date().toISOString().slice(11, 19), text: reason, level: 'info' })
        }
      }
      if (stage.state === 'run' || stage.state === 'wait') stage.state = 'err'
    }
    this.run.status = 'err'
    // Unblock any orchestrator-level await that has no backing process to kill — chiefly the
    // inter-stage review gate's `await this.raise(...)`. Without this, cancelling while paused at the
    // gate leaves that resolver dangling: the stage loop never resumes, `finally`/drainPending never
    // run, and the coroutine + bridge socket leak forever. Draining auto-denies it so the loop reaches
    // its terminal path. (Agent onConfirm resolvers are also denied here — harmless, since their
    // sessions are killed just below and any late resolve is a no-op once cleared.)
    this.drainPending()
    this.update(); this.flush()
    for (const s of this.activeSessions) { try { s.cancel() } catch { /* ignore */ } }
    this.activeSessions.clear()
  }

  private mkAgentRuntime(id: string, name: string, role: string, provider: string, model: string): AgentRuntime {
    return { id, name, role, provider, model, state: 'wait', logs: [] }
  }

  private findAgent(agentId: string): AgentRuntime | undefined {
    for (const stage of this.run.stages) {
      const a = stage.agents.find(x => x.id === agentId)
      if (a) return a
    }
    return undefined
  }

  private beat(agentId: string) {
    this.heartbeater?.beat(agentId)
    const agent = this.findAgent(agentId)
    if (agent) agent.lastBeat = this.now()
    this.bus.emit({ type: 'agent:heartbeat', agentId, at: this.now() })
  }

  private setAgentAwaiting(agent: AgentRuntime, awaiting: boolean) {
    this.heartbeater?.setAwaiting(agent.id, awaiting)
    agent.lastBeat = this.now()
    if (agent.state !== 'ok' && agent.state !== 'err') {
      agent.state = awaiting ? 'awaiting' : 'run'
      this.bus.emit({ type: 'agent:state', agentId: agent.id, state: agent.state })
      this.update(true)
    }
  }

  private applyHeartbeatEffects(effects: HeartbeatEffect[]) {
    for (const eff of effects) {
      const agent = this.findAgent(eff.agentId)
      if (!agent || agent.state === 'ok' || agent.state === 'err') continue
      if (eff.kind === 'stall') {
        agent.state = 'stalled'
        const secs = Math.round(eff.silentMs / 1000)
        this.pushLog(agent, { ts: timeStr(), text: `疑似卡住:${secs}s 无响应`, level: 'info' })
        this.bus.emit({ type: 'agent:state', agentId: agent.id, state: 'stalled' })
        this.bus.emit({ type: 'agent:stalled', agentId: agent.id, agentName: agent.name, wsName: this.run.workspaceName, silentMs: eff.silentMs })
        this.update(true)
      } else {
        this.pushLog(agent, { ts: timeStr(), text: `${Math.round(eff.silentMs / 1000)}s 无响应,已终止`, level: 'info' })
        agent.state = 'err'
        this.bus.emit({ type: 'agent:state', agentId: agent.id, state: 'err' })
        for (const s of this.activeSessions) {
          if (s.id === agent.id) { try { s.cancel() } catch { /* ignore */ } }
        }
        this.update(true)
      }
    }
  }

  private callbacksFor(stage: StageRuntime, agent: AgentRuntime, store: RunStore): AgentCallbacks {
    return {
      onLog: (line) => { this.beat(agent.id); this.pushLog(agent, line); this.bus.emit({ type: 'agent:log', agentId: agent.id, line }); this.update() },
      // Liveness only: refresh the heartbeat (a lightweight agent:heartbeat) without pushing a log
      // line or a full store update. Keeps the stall watchdog alive during logless stretches such as
      // streaming a large tool-input. Volume is bounded by stdout 'data' events (coarse), not per line.
      onActivity: () => { this.beat(agent.id) },
      onUsage: (u) => {
        if (!u.window) return
        agent.ctxPct = Math.max(0, Math.min(100, Math.round((u.used / u.window) * 100)))
        agent.ctxMax = Math.round(u.window / 1000)
        this.update()
      },
      // 'err' is terminal: once the watchdog killed the agent (or it errored), a late onState('ok') from
      // the provider's process-exit handler must NOT resurrect it to 'ok' — otherwise a killed scan would
      // count as success and the stage would gate an INCOMPLETE plan instead of halting.
      onState: (s) => { if (agent.state === 'err') return; if (s === 'run') this.beat(agent.id); agent.state = s; this.bus.emit({ type: 'agent:state', agentId: agent.id, state: s }); this.update(true) },
      onConfirm: async (req) => {
        const id = `p${++this.pendingSeq}`
        store.appendMessage({ id, runId: this.run.id, from: { runId: this.run.id, stageKey: stage.key, agentId: agent.id, name: agent.name }, to: 'orchestrator', type: 'confirm', payload: req, artifacts: [], ts: timeStr() })
        this.setAgentAwaiting(agent, true)
        const r = await this.raise({ id, kind: 'confirm', agentId: agent.id, agentName: agent.name, wsName: this.run.workspaceName, title: req.title, where: req.where, provider: agent.provider, model: agent.model, role: agent.role })
        this.setAgentAwaiting(agent, false)
        // forge_ask confirm cards are not reworkable (no 'modify' UI); coerce defensively so an
        // unexpected 'modify' never reads as approval.
        return r.decision === 'allow' ? 'allow' : 'deny'
      },
      onInput: async (req) => {
        const id = `p${++this.pendingSeq}`
        store.appendMessage({ id, runId: this.run.id, from: { runId: this.run.id, stageKey: stage.key, agentId: agent.id, name: agent.name }, to: 'orchestrator', type: 'input', payload: req, artifacts: [], ts: timeStr() })
        this.setAgentAwaiting(agent, true)
        const r = await this.raise({ id, kind: 'input', agentId: agent.id, agentName: agent.name, wsName: this.run.workspaceName, title: req.title, placeholder: req.placeholder, provider: agent.provider, model: agent.model, role: agent.role })
        this.setAgentAwaiting(agent, false)
        return r.value ?? ''
      },
      onDone: () => this.update(),
      // Surface the error as a log line so a failed agent leaves a diagnostic, not just a state flip.
      onError: (err) => {
        const l = { ts: timeStr(), text: `错误: ${err.message}`, level: 'info' as const }
        this.pushLog(agent, l); this.bus.emit({ type: 'agent:log', agentId: agent.id, line: l }); this.update()
      },
      onSession: (id) => { store.setAgentSession(agent.id, agent.provider, id) },
      onHandoff: (p) => {
        this.beat(agent.id)
        store.setContext('handoff:' + agent.id, p.summary)
        // Capture the design doc the agent wrote (a .md artifact) so the design gate can surface it
        // as an openable file. Keyed separately from the summary; no-op when no doc was reported.
        const docPath = pickDocArtifact(p.artifacts)
        if (docPath) {
          store.setContext('handoff-doc:' + agent.id, docPath)
          // Also record it on the stage so the narrator can carry a clickable DesignDocRef onto the
          // persisted stage-note message — the doc stays openable after the design-gate card unmounts.
          const cwd = this.agentCwd.get(agent.id)
          if (cwd) {
            if (!stage.docs) stage.docs = []
            if (!stage.docs.some(d => d.path === docPath && d.cwd === cwd)) {
              stage.docs.push({ path: docPath, cwd, name: agent.name })
            }
          }
          const dl = { ts: timeStr(), text: `文档 → ${docPath}`, level: 'accent' as const }
          this.pushLog(agent, dl); this.bus.emit({ type: 'agent:log', agentId: agent.id, line: dl }); this.update()
        }
        store.appendMessage({ id: 'h' + (++this.pendingSeq), runId: this.run.id, from: { runId: this.run.id, stageKey: stage.key, agentId: agent.id, name: agent.name }, to: 'orchestrator', type: 'handoff', payload: p, artifacts: p.artifacts ?? [], ts: timeStr() })
        this.briefs.push({ agentName: agent.name, summary: p.summary, artifacts: p.artifacts ?? [] })
        const l = { ts: timeStr(), text: `交接 → ${p.summary.slice(0, 80)}`, level: 'accent' as const }
        this.pushLog(agent, l); this.bus.emit({ type: 'agent:log', agentId: agent.id, line: l }); this.update()
      }
    }
  }

  // forge_ask 冒泡卡片时,用触发卡片的子代理自身 provider+model 做 fire-and-forget 一句解释,
  // 通过 pending:annotate 补到卡片上。fail-open:不阻塞、失败静默(见 explain.ts)。
  // 注意:runExplain 内部创建的 AgentSession 故意不纳入 activeSessions/heartbeater ——
  // 该调用有界(一句话)、fail-open、自完成;取消运行时它自行跑完即弃,
  // onNote 若发现 pending 已被 drain 则无副作用,不会引发任何状态异常。
  private explain(pendingId: string, rt: AgentRuntime, question: string, options?: { t: string; d: string }[]) {
    runExplain(
      this.providers[rt.provider],
      { pendingId, name: rt.name, model: rt.model, cwd: this.agentCwd.get(rt.id) ?? this.run.workspacePath, question, options, env: buildAgentEnv({ proxy: this.proxy() }) },
      (id, note) => {
        const entry = this.run.pending.find(p => p.id === id)
        if (entry) (entry as { note?: string }).note = note
        this.bus.emit({ type: 'pending:annotate', id, note })
      },
    )
  }

  // Read a design doc's content from disk (path relative to the agent's cwd). Best-effort: returns
  // undefined on any failure (missing file, read error) so the gate falls back to the summary body.
  // Guards against path traversal escaping the agent's cwd.
  private readDoc(doc: DesignDoc): string | undefined {
    try {
      const root = resolve(doc.cwd)
      const full = resolve(root, doc.path)
      if (full !== root && !full.startsWith(root + sep)) return undefined
      return readFileSync(full, 'utf8')
    } catch { return undefined }
  }

  // Run one agent task; a synchronous OR asynchronous throw from the provider is contained here and
  // marked on the agent, so one bad task never rejects Promise.all and bypasses run finalization.
  private async runTask(provider: AgentProvider, stage: StageRuntime, spec: StageSpec, agent: AgentRuntime, cwd: string, store: RunStore, env: NodeJS.ProcessEnv, lens?: ReviewLens) {
    this.agentCwd.set(agent.id, cwd)
    try {
      // this.briefs is read at task start; parallel develop-stage agents all get the same
      // pre-stage snapshot (briefs pushed mid-stage by a sibling don't retroactively appear — by design)
      const prompt = buildStagePrompt(spec.name, this.briefs, { textFallback: !provider.capabilities.mcpTools, task: this.task, lens, stageKey: spec.key, stageAppend: spec.prompt, reworkNote: spec.reworkNote, producesDoc: spec.producesDoc ?? spec.key === 'design' })
      const session = provider.run(
        { stageKey: stage.key, agentId: agent.id, name: agent.name, prompt, cwd, model: spec.model, permissionMode: this.permissionMode },
        this.callbacksFor(stage, agent, store), env
      )
      this.activeSessions.add(session)
      this.heartbeater?.add(agent.id)
      agent.lastBeat = this.now()
      try {
        await session.done
      } finally {
        this.activeSessions.delete(session)
        this.heartbeater?.remove(agent.id)
      }
    } catch (err) {
      agent.state = 'err'
      const e = err instanceof Error ? err : new Error(String(err))
      const l = { ts: timeStr(), text: `代理异常: ${e.message}`, level: 'info' as const }
      this.pushLog(agent, l)
      this.bus.emit({ type: 'agent:state', agentId: agent.id, state: 'err' })
      this.bus.emit({ type: 'agent:log', agentId: agent.id, line: l })
      this.update()
    }
  }

  // Run one workflow-scope plugin as a single restricted hook micro-agent in the workspace root.
  // Surfaced as a StageRuntime (key 'hook:'+id) with one agent (role '插件 · HOOK', hook:true) so it
  // reuses the normal stage rendering/events. Output is captured (output/ok log lines) and pushed as
  // a brief so downstream stages/hooks chain off it. NON-BLOCKING: a hook error never throws/aborts
  // the run — it still pushes a '插件失败: …' brief and the loop continues.
  private async runHook(plugin: Plugin, opts: StartRunOpts, store: RunStore): Promise<void> {
    const provId = opts.stages[0]?.provider ?? 'claude'
    const provider = this.providers[provId] ?? this.providers['claude']
    const model = opts.stages[0]?.model ?? ''
    const hookAgent: AgentRuntime = {
      id: 'hook:' + plugin.id, name: plugin.name, role: '插件 · HOOK',
      provider: provId, model, state: 'run', logs: [],
      hook: true, hookSkills: plugin.skills, hookTools: plugin.tools,
    }
    const stage: StageRuntime = { key: 'hook:' + plugin.id, name: plugin.name, state: 'run', agents: [hookAgent] }
    this.run.stages.push(stage)
    this.bus.emit({ type: 'agent:state', agentId: hookAgent.id, state: 'run' })
    this.update()

    if (!provider) {
      hookAgent.state = 'err'; stage.state = 'err'
      this.pushLog(hookAgent, { ts: timeStr(), text: `未找到插件 provider: ${provId}`, level: 'info' })
      this.bus.emit({ type: 'agent:state', agentId: hookAgent.id, state: 'err' }); this.update()
      this.briefs.push({ agentName: plugin.name, summary: '插件失败: 未找到 provider', artifacts: [] })
      return
    }

    const prompt = buildPluginPrompt(plugin, this.briefs, this.task)
    const allowedTools = claudeAllowedTools(plugin.tools)

    const baseEnv = buildAgentEnv({ proxy: this.proxy() })
    if (this.bridge) {
      (baseEnv as Record<string, string>).FORGE_SOCKET = this.bridge.socketPath
      if (this.mcpEntry) (baseEnv as Record<string, string>).FORGE_MCP_ENTRY = this.mcpEntry;
      (baseEnv as Record<string, string>).FORGE_TOOLS = STAGE_FORGE_TOOLS
    }
    const env: NodeJS.ProcessEnv = this.bridge ? { ...baseEnv, FORGE_AGENT_ID: hookAgent.id } : baseEnv
    hookAgent.context = mergeAgentContext(discoverAgentContext(opts.workspacePath, opts.workspacePath), forgeMcpContext(env))
    this.update(true)

    // Run the hook as a constrained micro-agent and capture its textual output (output kind / ok
    // level lines) for the brief summary. executeHook is RunState/RunStore-free; the orchestrator
    // registers/cleans up activeSessions+heartbeater via onSession.
    const result = await executeHook(
      provider,
      { stageKey: stage.key, agentId: hookAgent.id, name: plugin.name, prompt, cwd: opts.workspacePath, model, allowedTools, skills: plugin.skills },
      this.callbacksFor(stage, hookAgent, store),
      env,
      {
        onSession: (s) => {
          this.activeSessions.add(s)
          this.heartbeater?.add(hookAgent.id)
          hookAgent.lastBeat = this.now()
          s.done.finally(() => { this.activeSessions.delete(s); this.heartbeater?.remove(hookAgent.id) })
        },
      },
    )

    // On exception, mirror the prior catch block: surface the error log + force agent err state.
    if (result.error) {
      hookAgent.state = 'err'
      this.pushLog(hookAgent, { ts: timeStr(), text: `插件异常: ${result.error}`, level: 'info' })
      this.bus.emit({ type: 'agent:state', agentId: hookAgent.id, state: 'err' }); this.update()
    }

    const failed = !result.ok
    stage.state = failed ? 'err' : 'ok'
    this.update()
    const summary = failed
      ? '插件失败: ' + (result.error || result.output.trim() || '执行未成功')
      : (result.output.trim() || '插件完成')
    this.briefs.push({ agentName: plugin.name, summary, artifacts: [] })
  }

  async startRun(opts: StartRunOpts): Promise<RunState> {
    if (this.run && this.run.status === 'run') throw new Error('已有运行进行中，无法并发启动')
    const store = new RunStore(opts.workspacePath, opts.runId)
    this.store = store
    // Resume seeds the completed stages' handoff summaries so the remaining stages inherit context.
    this.briefs = opts.resume ? [...opts.resume.priorBriefs] : []
    this.task = opts.task
    this.permissionMode = opts.permissionMode
    this.cancelled = false
    this.run = { id: opts.runId, workspaceName: opts.workspaceName, workspacePath: opts.workspacePath, sessionId: opts.sessionId, workflowId: opts.workflowId, workflowName: opts.workflowName, projects: opts.developProjects.map(p => ({ name: p.name, cwd: p.cwd })), status: 'run', stages: opts.resume ? [...opts.resume.completedStages] : [], pending: [] }
    this.heartbeater = new Heartbeater(this.hbCfg, this.now)
    this.hbTimer = this.makeInterval(() => this.applyHeartbeatEffects(this.heartbeater?.tick() ?? []), this.hbCfg.pingMs)
    this.update()

    // Kick off the Forge bridge start. The Promise is captured and NOT awaited
    // synchronously here so that this.run.status='run' is set before any I/O yield,
    // keeping the concurrent-guard test timing correct. It IS awaited inside the try
    // block, just before the run loop, via a helper that populates this.bridge.
    this.bridge = null
    const bridgeCtx = {
      store,
      runId: opts.runId,
      workspaceName: opts.workspaceName,
      agentName: (id: string) => {
        for (const stage of this.run.stages) {
          const agent = stage.agents.find(a => a.id === id)
          if (agent) return agent.name
        }
        return id
      },
      agentStage: (id: string) => {
        for (const stage of this.run.stages) {
          if (stage.agents.some(a => a.id === id)) return stage.key
        }
        return ''
      },
      onBeat: (agentId: string) => this.beat(agentId),
      ask: async (agentId: string, question: string, options?: { t: string; d: string }[]): Promise<string | null> => {
        const id = `mcp-ask-${++this.pendingSeq}`
        const name = bridgeCtx.agentName(agentId)
        // Look up the requesting agent's runtime to enrich the card head/sub.
        let rt: AgentRuntime | undefined
        for (const stage of this.run.stages) { const a = stage.agents.find(x => x.id === agentId); if (a) { rt = a; break } }
        const rich = { provider: rt?.provider, model: rt?.model, role: rt?.role }
        if (rt) this.explain(id, rt, question, options)
        if (options && options.length > 0) {
          if (rt) this.setAgentAwaiting(rt, true)
          const r = await this.raise({ id, kind: 'select', agentId, agentName: name, wsName: opts.workspaceName, title: question, options, ...rich })
          if (rt) this.setAgentAwaiting(rt, false)
          if (r.decision === 'deny') return null
          return options[r.choice ?? 0].t
        }
        if (rt) this.setAgentAwaiting(rt, true)
        const r = await this.raise({ id, kind: 'input', agentId, agentName: name, wsName: opts.workspaceName, title: question, ...rich })
        if (rt) this.setAgentAwaiting(rt, false)
        return r.decision === 'allow' ? (r.value ?? '') : null
      },
      setContext: (k: string, v: unknown) => {
        if (k.startsWith('handoff:')) {
          const agentId = k.slice('handoff:'.length)
          this.briefs.push({ agentName: bridgeCtx.agentName(agentId), summary: String(v), artifacts: [] })
        }
        store.setContext(k, v)
      },
    }
    const bridgePromise: Promise<ForgeBridge | null> = startBridge(store.runDir, bridgeCtx).catch(err => {
      console.warn('[Forge] bridge start failed — run continues without MCP', err)
      return null
    })

    try {
      // Resolve the bridge before building any agent env so FORGE_SOCKET is available.
      this.bridge = await bridgePromise

      const woven = weavePlugins(opts.stages, opts.plugins ?? [])
      for (let stepIdx = 0; stepIdx < woven.length; stepIdx++) {
        const step = woven[stepIdx]
        if (this.cancelled) break
        if (step.kind === 'hook') { await this.runHook(step.plugin, opts, store); continue }
        const spec = step.stage
        const provider = this.providers[spec.provider]
        const stage: StageRuntime = { key: spec.key, name: spec.name, state: 'run', agents: [] }
        this.run.stages.push(stage)
        this.update()

        // 每阶段返工循环:跑该阶段 → 弹评审门控。用户「打回重做」(decision:'modify')时,带着修改方向
        // 重跑本阶段产出新版本,再弹门控;直到「允许并继续」(进下一步)或「终止」(deny,停整个 run)。
        // briefsBase:本阶段开始时的上游 briefs 快照长度 —— 每次重跑回退到它,好让新版只看到真正的
        // 上游交接 + 用户修改方向,而不是把自己上一版的产出当成上游。
        const briefsBase = this.briefs.length
        let reworkNote: string | undefined
        let round = 0
        while (true) {
          if (this.cancelled) break
          if (round > 0) {
            // 重跑前重置本阶段:清掉上一版的 agents/docs、状态回到 run、briefs 回退到快照。
            stage.agents = []
            stage.docs = undefined
            stage.state = 'run'
            this.briefs.length = briefsBase
            this.update()
          }
          // 修改方向经 spec.reworkNote → runTask → buildStagePrompt 注入;round 0 时为 undefined(无影响)。
          spec.reworkNote = reworkNote

          const baseEnv = buildAgentEnv({ proxy: this.proxy() })
          // Inject bridge socket into base env; FORGE_AGENT_ID is added per-task below.
          if (this.bridge) {
            (baseEnv as Record<string, string>).FORGE_SOCKET = this.bridge.socketPath
            if (this.mcpEntry) (baseEnv as Record<string, string>).FORGE_MCP_ENTRY = this.mcpEntry;
            // Limit stage sub-agents to the execution toolset (no forge_propose_plan) so they
            // can't be lured into proposing instead of doing their assigned stage work.
            (baseEnv as Record<string, string>).FORGE_TOOLS = STAGE_FORGE_TOOLS
          }

          const tasks: { agent: AgentRuntime; cwd: string; provider: AgentProvider | undefined; model: string; lens?: ReviewLens }[] = []
          // Any stage carrying a review config fans out parallel reviewers (built-in 'review' gets one by
          // default via resolveStages; custom stages opt in explicitly).
          if (spec.review) {
            const reviewers: ReviewerTask[] = buildReviewTasks(
              spec.review,
              opts.developProjects.map(p => ({ name: p.name, cwd: p.cwd })),
              { name: spec.name, cwd: opts.workspacePath },
            )
            for (const r of reviewers) {
              const agent = this.mkAgentRuntime(
                r.id, r.lens ? `${spec.name} · ${lensLabel(r.lens)}` : r.name, spec.name, spec.provider, spec.model,
              )
              stage.agents.push(agent); tasks.push({ agent, cwd: r.cwd, provider, model: spec.model, lens: r.lens })
            }
          } else if (stageScope(spec) === 'per-project' && opts.developProjects.length > 0) {
            // Per-stage project scoping: a stage may run on only a subset of projects (spec.projects, by
            // name). Falls back to ALL projects when unset or when the filter matches nothing (never a
            // no-op stage). Lets e.g. 需求分析 cover all 5 projects while 开发 touches only 2.
            const scoped = spec.projects?.length ? opts.developProjects.filter(p => spec.projects!.includes(p.name)) : opts.developProjects
            const stageProjs = scoped.length ? scoped : opts.developProjects
            // projectAgent: run with each project's own provider/model (develop's default); other
            // per-project stages (e.g. design) keep the stage's provider/model but run in the project cwd.
            const projectAgent = spec.projectAgent ?? spec.key === 'develop'
            for (const proj of stageProjs) {
              const provId = projectAgent ? (proj.provider ?? spec.provider) : spec.provider
              const mdl = projectAgent ? (proj.model ?? spec.model) : spec.model
              // name = the project (prominent card title), role = the stage (subtitle) — so the UI
              // clearly shows which project each agent works on and at which stage. proj.name is now
              // non-empty (workspaceToStartRunOpts falls back to repoId), so no "在  中X" label.
              const agent = this.mkAgentRuntime(`${stage.key}:${proj.name}`, proj.name, spec.name, provId, mdl)
              stage.agents.push(agent); tasks.push({ agent, cwd: proj.cwd, provider: this.providers[provId], model: mdl })
            }
          } else {
            const agent = this.mkAgentRuntime(stage.key, spec.name, spec.name, spec.provider, spec.model)
            stage.agents.push(agent); tasks.push({ agent, cwd: opts.workspacePath, provider, model: spec.model })
          }

          const missingProvider = tasks.find(t => !t.provider)
          if (missingProvider) {
            for (const { agent } of tasks) {
              if (!agent.state || agent.state === 'wait') {
                agent.state = 'err'
                this.pushLog(agent, { ts: timeStr(), text: `未找到代理 provider: ${agent.provider}`, level: 'info' })
              }
            }
            stage.state = 'err'; this.update(); break
          }

          const runOne = ({ agent, cwd, provider: taskProvider, model: taskModel, lens }: typeof tasks[number]) => {
            // Build per-agent env: spread base env, override FORGE_AGENT_ID for this specific agent.
            const agentEnv: NodeJS.ProcessEnv = this.bridge
              ? { ...baseEnv, FORGE_AGENT_ID: agent.id }
              : baseEnv
            agent.context = mergeAgentContext(discoverAgentContext(cwd, opts.workspacePath), forgeMcpContext(agentEnv))
            this.update(true)
            return this.runTask(taskProvider!, stage, { ...spec, model: taskModel }, agent, cwd, store, agentEnv, lens)
          }
          await Promise.all(tasks.map(runOne))

          // Per-project retry: if some projects failed (transient hang/kill/rate-limit), re-run ONLY those —
          // the projects that already succeeded are kept, so we don't waste tokens re-scanning them. Only
          // after the retry still fails does the stage fail + halt (below).
          for (let attempt = 1; attempt <= this.projectRetries && !this.cancelled; attempt++) {
            const failedTasks = tasks.filter(t => t.agent.state !== 'ok')
            if (!failedTasks.length) break
            this.pushLog(failedTasks[0].agent, { ts: timeStr(), text: `${failedTasks.length} 个项目未完成,只重试它们(第 ${attempt} 次)…`, level: 'info' })
            for (const t of failedTasks) { t.agent.state = 'run'; this.bus.emit({ type: 'agent:state', agentId: t.agent.id, state: 'run' }) } // reset so the terminal-err guard allows the retry
            this.update(true)
            await Promise.all(failedTasks.map(runOne))
          }

          // summary: after the per-project agents finish, append one 汇总 agent that consolidates their
          // outputs (design's default). Custom stages opt in via spec.summary.
          if (
            (spec.summary ?? spec.key === 'design') &&
            stageScope(spec) === 'per-project' &&
            opts.developProjects.length > 0 &&
            stage.agents.every(a => a.state === 'ok')
          ) {
            const summary = this.mkAgentRuntime(`${spec.key}:summary`, '主代理', `${spec.name} · 汇总`, spec.provider, spec.model)
            stage.agents.push(summary)
            const summaryEnv: NodeJS.ProcessEnv = this.bridge
              ? { ...baseEnv, FORGE_AGENT_ID: summary.id }
              : baseEnv
            summary.context = mergeAgentContext(discoverAgentContext(opts.workspacePath, opts.workspacePath), forgeMcpContext(summaryEnv))
            this.update(true)
            await this.runTask(provider, stage, { ...spec, name: `${spec.name}汇总`, scope: 'root' }, summary, opts.workspacePath, store, summaryEnv)
          }

          stage.state = stage.agents.length > 0 && stage.agents.every(a => a.state === 'ok') ? 'ok' : 'err'
          this.update()
          // A stage where any agent failed/was-killed is INCOMPLETE — halt the whole run here instead of
          // gating/continuing on a partial plan (an incomplete plan isn't worth proceeding with). Surface
          // it clearly so the user knows to re-run rather than think the plan is done.
          if (stage.state === 'err') {
            const failedAgents = stage.agents.filter(a => a.state !== 'ok')
            const marker = failedAgents[0] ?? stage.agents[0]
            if (marker) this.pushLog(marker, {
              ts: timeStr(),
              text: `「${spec.name}」有 ${failedAgents.length} 个代理未完成(失败/被终止),本阶段不完整,已中止工作流 —— 请重新运行(慢代理超时已放宽)。`,
              level: 'info',
            })
            break
          }

          // Inter-stage review gate: after a gated stage completes OK, pause and ask the user to review
          // the output. Reuses the raise/pending/resolve mechanism (no new IPC). The stage output is
          // already surfaced to chat by the per-stage narrator 回流; this adds the pause + 三选一:
          //   allow  → approve, proceed to the next stage
          //   modify → 打回重做: re-run THIS stage with the user's revision direction (loop), then re-gate
          //   deny   → 终止: stop the whole run
          // Gate resolution: explicit spec.gate wins (production sets true on every stage incl. the last).
          // The design-only FALLBACK additionally skips the last WOVEN step, preserving the old behavior
          // where a bare design-last stage doesn't self-gate.
          const isLast = stepIdx === woven.length - 1
          const gated = spec.gate ?? (REVIEW_GATED_STAGES.has(spec.key) && !isLast)
          if (!gated || this.cancelled) break
          const id = `review-${spec.key}-${++this.pendingSeq}`
          // Collect the docs agents wrote to disk (openable in the in-app viewer). The gate body prefers
          // the consolidated doc's full content (summary agent is appended last, so it's the last doc);
          // it falls back to the assembled handoff summaries when no doc exists.
          const docs = buildDesignDocs(
            stage.agents,
            aid => store.getContext('handoff-doc:' + aid) as string | undefined,
            aid => this.agentCwd.get(aid),
          )
          const body = gateBodyFromDoc(
            docs[docs.length - 1],
            (d: DesignDoc) => this.readDoc(d),
            () => buildGateBody(
              stage.agents,
              aid => store.getContext('handoff:' + aid),
              aid => outputFromLogs(stage.agents.find(a => a.id === aid)?.logs),
            ),
          )
          const decision = await this.raise({
            id, kind: 'confirm',
            agentId: `stage:${spec.key}`, agentName: spec.name,
            wsName: this.run.workspaceName,
            title: `「${spec.name}」阶段完成 — 审阅后可继续、打回重做、或终止本次运行`,
            role: '阶段评审',
            body,
            docs: docs.length ? docs : undefined,
            reworkable: true,
          })
          if (decision.decision === 'deny') {
            // 终止 → stop the whole run. cancel() marks the run err, drains pending, and stops sessions;
            // we're mid-run (status==='run') so it applies cleanly. The post-loop break leaves the
            // remaining stages unexecuted; the finally block finalizes status (already 'err').
            this.cancel(`「${spec.name}」被终止,已停止本次运行`)
            break
          }
          if (decision.decision === 'modify') {
            // 打回重做 → loop: re-run this same stage carrying the user's revision direction. #6: the
            // feedback first goes through the main agent (analyzeRework), which analyzes it against the
            // task + this stage's output and produces a focused, on-theme directive for the sub-agent,
            // rather than piping the raw user words straight in. Empty direction still triggers a redo.
            reworkNote = await this.analyzeRework(spec, body ?? '', (decision.value ?? '').trim())
            round++
            continue
          }
          // Approved. Persist it so a later resume treats this gated stage as truly done. Without this,
          // a gated stage that reached 'ok' but was cancelled AT the gate would be skipped on resume.
          store.setContext(gateApprovedKey(spec.key), true)
          break
        }
        // 本阶段(含多轮返工)收尾:出错、或被取消/终止 → 不再往后跑。
        if (stage.state === 'err' || this.cancelled) break
      }

      // 工作流完成后 hooks: after the stage loop completes and the run finished normally (NOT
      // cancelled, incl. no design-gate rejection), run each step-scope plugin with after==='__wf'
      // in order. Placed here — after all stages, still inside the try so it runs BEFORE the finally
      // block finalizes the terminal ok/err status — so these hooks become trailing stages that the
      // every()-ok check still accounts for. runHook is non-blocking (a hook error pushes a failure
      // brief, doesn't throw). __basic/__proj step plugins are DEFERRED (run during createWorkspace)
      // and are intentionally NOT executed here.
      if (!this.cancelled) {
        for (const plugin of opts.stepPlugins ?? []) {
          if (this.cancelled) break
          if (plugin.after === '__wf') await this.runHook(plugin, opts, store)
        }
      }
    } finally {
      this.drainPending()
      // A cancelled run (incl. a design-gate rejection) is always terminal err, even if every
      // executed stage happened to be 'ok' (the remaining stages simply never ran). Without this
      // guard the every()-ok check below would resurrect status to 'ok' after a mid-run cancel
      // that occurred AFTER a stage finished ok (e.g. the design review gate denied).
      this.run.status = this.cancelled
        ? 'err'
        : (this.run.stages.filter(s => !s.key.startsWith('hook:')).every(s => s.state === 'ok') ? 'ok' : 'err')
      this.update()
      // Let drained ask continuations flush their responses before the bridge sockets die.
      await new Promise(resolve => setImmediate(resolve))
      // Close the bridge socket after the run finishes (guard any close errors).
      try { await this.bridge?.close() } catch (err) { console.warn('[Forge] bridge close error', err) }
      this.bridge = null
      this.hbTimer?.clear(); this.hbTimer = null
      this.heartbeater = null
    }
    return this.run
  }
}

function timeStr() { return new Date().toISOString().slice(11, 19) }

function lensLabel(l: ReviewLens): string {
  return { correctness: '正确性', security: '安全', performance: '性能', style: '风格' }[l]
}
