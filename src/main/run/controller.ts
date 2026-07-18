// src/main/run/controller.ts
import type { PermissionMode } from '@shared/permissions'
import type { AgentProvider, ConfirmReq, InputReq } from '../agents/types'
import type { ArtifactRef } from '../orchestrator/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { RunStore } from '../orchestrator/runStore'
import { initMachine, markRunning, currentStage, type RunPlan, type MachineState } from './machine'
import { applyGateDecision, type GateDecision, type LaneDecision } from './decisions'
import { addEvent, removeEvent, findEvent, type RunEvent } from './events'
import { addFeedback, editFeedback, removeFeedback, drainFeedback, type FeedbackDraft } from './feedback'
import { ResolverRegistry } from './resolver'
import { buildWorkOrders, type StageInput } from './fanout'
import { runWorkOrder, type WorkOrder, type WorkOrderOutcome } from './workOrder'
import { saveControllerState } from './persist'

export interface RunControllerDeps {
  providers: Record<string, AgentProvider>
  store: RunStore
  env: NodeJS.ProcessEnv
  projects: DevelopProject[]
  retries?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  makeId?: (prefix: string) => string
  task?: string
  permissionMode?: PermissionMode
}
export type RunStatus = 'running' | 'awaiting' | 'ok' | 'failed'
export interface LiveLane { stageKey: string; project?: string; state?: string; activity?: string }
// A single raw agent log line broadcast live during a run. Deliberately NOT part of
// RunControllerState — logs are a high-frequency stream, not durable state: folding them into
// state would bloat every emitUpdate() snapshot and (via saveControllerState) write O(logs)
// times to disk. Consumers that want history must buffer onLog() themselves.
export interface RunLogLine { laneId: string; stageKey: string; project?: string; agentName: string; line: import('../agents/types').LogLine }
export interface RunControllerState {
  machine: MachineState
  inbox: RunEvent[]
  feedback: FeedbackDraft[]
  outcomes: Record<string, WorkOrderOutcome[]>
  status: RunStatus
  pendingDirective: Record<string, string>
  liveLanes: Record<string, LiveLane>
  stageTimings: Record<string, { startedAt: number; endedAt?: number }>
  paused: boolean
}

export class RunController {
  private machine: MachineState
  private inbox: RunEvent[] = []
  private feedback: FeedbackDraft[] = []
  private outcomes: Record<string, WorkOrderOutcome[]> = {}
  private status: RunStatus = 'running'
  private pendingDirective: Record<string, string> = {}
  private liveLanes: Record<string, LiveLane> = {}
  private stageTimings: Record<string, { startedAt: number; endedAt?: number }> = {}
  private aborted = false
  private paused = false
  // Set only while start()'s loop is actually parked at the pause gate (see start()); abort()
  // must resolve it to release a paused run, or start() would await it forever.
  private pauseResolve: (() => void) | null = null
  private laneR = new ResolverRegistry<LaneDecision>()
  private gateR = new ResolverRegistry<GateDecision>()
  private eventSubs: Array<(e: RunEvent) => void> = []
  private updateSubs: Array<(s: RunControllerState) => void> = []
  private logSubs: Array<(l: RunLogLine) => void> = []
  private idn = 0
  private makeId: (p: string) => string
  private now: () => number

  constructor(private plan: RunPlan, private deps: RunControllerDeps) {
    this.machine = initMachine(plan)
    this.makeId = deps.makeId ?? ((p) => `${p}-${this.idn++}`)
    this.now = deps.now ?? Date.now
  }

  onEvent(fn: (e: RunEvent) => void) { this.eventSubs.push(fn); return () => { this.eventSubs = this.eventSubs.filter((f) => f !== fn) } }
  onUpdate(fn: (s: RunControllerState) => void) { this.updateSubs.push(fn); return () => { this.updateSubs = this.updateSubs.filter((f) => f !== fn) } }
  // Separate subscription from onUpdate: log lines are broadcast live but never folded into
  // `state` and never persisted (see RunLogLine / emitLog below).
  onLog(fn: (l: RunLogLine) => void) { this.logSubs.push(fn); return () => { this.logSubs = this.logSubs.filter((f) => f !== fn) } }
  get state(): RunControllerState {
    return { machine: this.machine, inbox: [...this.inbox], feedback: [...this.feedback], outcomes: this.outcomes, status: this.status, pendingDirective: { ...this.pendingDirective }, liveLanes: { ...this.liveLanes }, stageTimings: { ...this.stageTimings }, paused: this.paused }
  }
  private emitEvent(e: RunEvent) { this.inbox = addEvent(this.inbox, e); for (const f of this.eventSubs) f(e); this.emitUpdate() }
  private drop(id: string) { this.inbox = removeEvent(this.inbox, id) }
  private emitUpdate() { const s = this.state; for (const f of this.updateSubs) f(s); saveControllerState(this.deps.store, s) }
  // No emitUpdate() here on purpose: a log line is not a state change, so it must not trigger
  // an onUpdate snapshot or a saveControllerState disk write.
  private emitLog(l: RunLogLine) { for (const f of this.logSubs) f(l) }

  addFeedback(text: string) { this.feedback = addFeedback(this.feedback, this.makeId('fb'), text); this.emitUpdate() }
  editFeedback(id: string, text: string) { this.feedback = editFeedback(this.feedback, id, text); this.emitUpdate() }
  removeFeedback(id: string) { this.feedback = removeFeedback(this.feedback, id); this.emitUpdate() }

  resolveGate(eventId: string, d: GateDecision): boolean {
    const e = findEvent(this.inbox, eventId)
    if (!e || e.kind !== 'gate') return false
    return this.gateR.settle(eventId, d)
  }
  resolveLane(eventId: string, d: LaneDecision): boolean {
    const e = findEvent(this.inbox, eventId)
    if (!e || e.kind === 'gate') return false
    // Settle first: settle() is the idempotent source of truth (map entry consumed exactly once).
    // Only flip `aborted` if this call actually won the race to settle a still-pending resolver —
    // a stale/duplicate abort call must not resurrect an already-finished run.
    const ok = this.laneR.settle(eventId, d)
    if (ok && d.type === 'abort') {
      this.aborted = true
      // Force-unblock every other in-flight lane/gate await so concurrently-running lanes
      // (Promise.all in start()) don't hang forever waiting on a resolver nobody will settle.
      // The post-await sites are abort-aware (short-circuit / drop-and-break), so these forced
      // values never drive spurious retries or gate advances.
      this.laneR.settleAll({ type: 'abort' })
      this.gateR.settleAll({ type: 'advance' })
      // Same pause-gate release as abort() (see its comment): in practice a live lane event
      // can't coexist with the loop being parked at the pause gate (no in-flight lane survives
      // to a stage boundary), so this is defense-in-depth rather than a reachable-today path —
      // but duplicating the settleAll fan-out without it would be a latent hang waiting for a
      // future change to that invariant.
      const r = this.pauseResolve
      this.pauseResolve = null
      r?.()
    }
    return ok
  }

  /**
   * Force-abort a run from outside any live lane/gate event — e.g. a run parked at a GATE (or
   * between stages, where resolveLane/resolveGate have nothing to attach to) can only be
   * cancelled through this entry point. Mirrors the settleAll fan-out that resolveLane's abort
   * branch does, so every in-flight lane/gate await unblocks the same way regardless of which
   * path triggered the abort.
   */
  abort(): void {
    this.aborted = true
    this.laneR.settleAll({ type: 'abort' })
    this.gateR.settleAll({ type: 'advance' })
    // Release the pause gate too: if the run was paused (parked in start()'s
    // `while (this.paused && !this.aborted) await ...` at a stage boundary), the settleAll calls
    // above don't touch it — nothing else will ever resolve pauseResolve. Without this, aborting
    // a paused run hangs start() forever. The loop re-checks `!this.aborted` after waking up, so
    // it exits via the `if (this.aborted) break` right after — leaving `paused` true here is
    // harmless.
    const r = this.pauseResolve
    this.pauseResolve = null
    r?.()
    this.emitUpdate()
  }

  /** Requests a pause; takes effect at the next stage boundary (in-flight lanes are not interrupted — use abort() for that). No-op once the run has ended or already aborted. */
  pause(): void {
    if (this.aborted || this.status !== 'running') return
    this.paused = true
    this.emitUpdate()
  }

  /** Clears a pending pause and wakes the loop if it's currently parked at the pause gate. */
  resume(): void {
    if (!this.paused || this.aborted) return
    this.paused = false
    const r = this.pauseResolve
    this.pauseResolve = null
    this.emitUpdate()
    r?.()
  }

  private workspacePath(): string { return this.deps.store.runDir.replace(/\/\.forge\/runs\/[^/]+$/, '') }
  private upstream(uptoIndex: number): ArtifactRef[] {
    const refs: ArtifactRef[] = []
    for (let i = 0; i < uptoIndex; i++) {
      const got = this.deps.store.getContext('artifacts:' + this.plan.stages[i].key) as ArtifactRef[] | undefined
      if (got) refs.push(...got)
    }
    return refs
  }
  private buildPrompt = (o: { stageKey: string; project?: string; cwd: string; upstream: ArtifactRef[] }) => {
    const seed = this.deps.task ? `【需求原文（以此为准）】\n${this.deps.task}\n` : ''
    // The stage's real instructions (e.g. STAGE_PROMPTS['design']) live on the StagePlan, not on
    // the thin `o` passed in from fanout — look it up here so callers don't need to thread it through.
    const stagePrompt = this.plan.stages.find((s) => s.key === o.stageKey)?.prompt
    const instructions = stagePrompt ? `${stagePrompt}\n` : `【阶段】${o.stageKey}\n`
    const scope = `${o.project ? `（项目 ${o.project}）` : ''}cwd=${o.cwd}`
    const up = o.upstream.length ? `\n上游产物：\n${o.upstream.map((a) => `- ${a.path} (${a.kind})`).join('\n')}` : ''
    const dir = this.pendingDirective[o.stageKey] ? `\n【补充/返工意见】\n${this.pendingDirective[o.stageKey]}` : ''
    const fence = `\n完成后，请在回复最后输出一个如下格式的结果块（用于登记产物）：\n\`\`\`forge-result\n{"summary":"一句话说明你做了什么","filesChanged":["改动/产出的文件路径"],"testsRun":{"passed":true},"blockers":[],"doubts":[]}\n\`\`\`\n`
    return `${seed}${instructions}${scope}${up}${dir}${fence}`
  }

  private async runOneOrder(order: WorkOrder): Promise<WorkOrderOutcome> {
    const outcome = await this.runOneOrderLive(order)
    // Settled (ok or failed): the lane's final state now lives in `outcomes`, not `liveLanes`.
    delete this.liveLanes[order.id]
    this.emitUpdate()
    return outcome
  }

  private async runOneOrderLive(order: WorkOrder): Promise<WorkOrderOutcome> {
    return runWorkOrder(order, {
      provider: this.deps.providers[order.provider],
      env: this.deps.env,
      retries: this.deps.retries,
      sleep: this.deps.sleep,
      onProgress: (ev) => {
        this.liveLanes[ev.laneId] = {
          stageKey: order.stageKey,
          project: order.project,
          state: ev.state ?? this.liveLanes[ev.laneId]?.state,
          activity: ev.activity ?? this.liveLanes[ev.laneId]?.activity,
        }
        this.emitUpdate()
        if (ev.log) this.emitLog({ laneId: ev.laneId, stageKey: order.stageKey, project: order.project, agentName: order.name, line: ev.log })
      },
      onConfirm: async (req: ConfirmReq, laneId: string) => {
        // If the run was already aborted (e.g. by a sibling lane, or by a concurrent onEvent
        // resolving an EARLIER interaction with `abort`), a resolver created here would never
        // be settled by anything — resolveLane's settleAll already ran before this call started.
        // Short-circuit before create()/emitEvent() so we never register an orphaned resolver.
        if (this.aborted) return 'deny'
        const id = this.makeId('auth')
        // Register the resolver BEFORE emitting: a synchronous listener (the common case — the
        // caller resolves the lane right inside the onEvent callback) must find a live resolver
        // waiting, not settle into the void because create() hadn't run yet (would deadlock forever).
        const p = this.laneR.create(id)
        this.emitEvent({ id, kind: 'auth', laneId, stageKey: order.stageKey, title: req.title, where: req.where })
        const d = await p
        this.drop(id); this.emitUpdate()
        return d.type === 'authorize' ? 'allow' : 'deny'
      },
      onInput: async (req: InputReq, laneId: string) => {
        // Same abort short-circuit as onConfirm above — see comment there.
        if (this.aborted) return ''
        const id = this.makeId('question')
        const p = this.laneR.create(id)
        this.emitEvent({ id, kind: 'question', laneId, stageKey: order.stageKey, title: req.title, placeholder: req.placeholder })
        const d = await p
        this.drop(id); this.emitUpdate()
        return d.type === 'answer' ? d.value : ''
      },
    })
  }

  async start(): Promise<RunControllerState> {
    while (!this.aborted) {
      // Pause gate: sits at the very top of the loop, before the next stage is read/started, so
      // an in-flight stage's lanes always finish uninterrupted — pause only stops the run from
      // ADVANCING to the next stage boundary. `while` (not `if`) guards against a spurious wakeup
      // leaving the loop still paused; `aborted` is re-checked after the await because abort()
      // resolves this same promise to release the gate (see abort()) and must win over a stale
      // `paused` flag rather than let the loop try to start another stage.
      while (this.paused && !this.aborted) {
        await new Promise<void>((res) => { this.pauseResolve = res })
      }
      if (this.aborted) break
      const cur = currentStage(this.machine)
      if (!cur || cur.status === 'done') break
      this.machine = markRunning(this.machine); this.status = 'running'; this.emitUpdate()
      const idx = this.machine.currentIndex
      const stage = this.plan.stages[idx]
      this.stageTimings[stage.key] = { startedAt: this.now() }
      const input: StageInput = {
        stage: { ...stage },
        workspacePath: this.workspacePath(),
        projects: this.deps.projects,
        upstream: this.upstream(idx),
        buildPrompt: this.buildPrompt,
        permissionMode: this.deps.permissionMode,
      }
      const orders = buildWorkOrders(input)
      if (orders.length === 0) throw new Error(`RunController: stage "${stage.key}" produced no work orders (per-project needs >=1 project)`)

      // run all lanes concurrently
      let outcomes = await Promise.all(orders.map((o) => this.runOneOrder(o)))
      this.pendingDirective[stage.key] = '' // consumed

      // failure handling: surface + await lane decisions (retry/skip/abort)
      let unresolved = outcomes.filter((o) => o.status === 'failed')
      while (unresolved.length > 0 && !this.aborted) {
        this.status = 'awaiting'
        const waits = unresolved.map((oc) => {
          const id = this.makeId('failure')
          // Same create-before-emit ordering as onConfirm/onInput above.
          const p = this.laneR.create(id)
          this.emitEvent({ id, kind: 'failure', laneId: oc.order.id, stageKey: stage.key, error: oc.error ?? 'failed', attempts: oc.attempts })
          return p.then((d) => ({ oc, id, d }))
        })
        const resolved = await Promise.all(waits)
        const retried: WorkOrderOutcome[] = []
        for (const { oc, id, d } of resolved) {
          this.drop(id)
          if (d.type === 'abort') { this.aborted = true; break }
          if (d.type === 'retry') { retried.push(await this.runOneOrder(oc.order)) }
          // skipLane: treat as resolved (dropped, sibling unaffected)
        }
        if (this.aborted) {
          // The early `break` above stops iterating once an abort decision is seen, so any
          // remaining entries in this round (e.g. force-settled via resolveLane's settleAll)
          // never reached `this.drop(id)`. Drain them here so no orphaned FailureEvents linger
          // in the inbox. `drop` is idempotent (filter-based), so re-dropping already-dropped
          // ids is harmless.
          for (const { id } of resolved) this.drop(id)
        }
        this.emitUpdate()
        // recompute outcomes/unresolved from retried set
        outcomes = outcomes.map((o) => retried.find((r) => r.order.id === o.order.id) ?? o)
        unresolved = retried.filter((o) => o.status === 'failed')
      }
      if (this.aborted) break

      // write artifacts for ok lanes, surface doubts
      const refs: ArtifactRef[] = []
      for (const oc of outcomes) {
        if (oc.status === 'ok' && oc.result) {
          const ref = this.deps.store.writeArtifact(`${stage.key}-${oc.order.project ?? 'root'}.md`, oc.result.summary)
          refs.push(ref)
          for (const doubt of oc.result.doubts) {
            this.emitEvent({ id: this.makeId('doubt'), kind: 'doubt', laneId: oc.order.id, stageKey: stage.key, note: doubt })
          }
        }
      }
      this.deps.store.setContext('artifacts:' + stage.key, refs)
      this.outcomes[stage.key] = outcomes
      if (this.stageTimings[stage.key]) this.stageTimings[stage.key].endedAt = this.now()

      // gate or auto-advance
      if (stage.gate) {
        const id = this.makeId('gate')
        const body = refs.map((r) => r.path).join('\n')
        this.status = 'awaiting'
        const p = this.gateR.create(id)
        this.emitEvent({ id, kind: 'gate', stageKey: stage.key, body, docs: refs })
        const d = await p
        this.drop(id)
        if (this.aborted) break // force-settled by a concurrent lane abort; don't advance the machine
        if (d.type === 'redo') {
          const { text, drained } = drainFeedback(this.feedback); this.feedback = drained
          this.pendingDirective[stage.key] = [text, d.feedback].filter(Boolean).join('\n')
        } else if (d.type === 'jumpBack') {
          const { text, drained } = drainFeedback(this.feedback); this.feedback = drained
          this.pendingDirective[d.targetKey] = [text, d.feedback].filter(Boolean).join('\n')
        }
        this.machine = applyGateDecision(this.machine, d)
      } else {
        this.machine = applyGateDecision(this.machine, { type: 'advance' })
      }
      this.emitUpdate()
      if (this.machine.stages.every((s) => s.status === 'done')) break
    }

    this.status = this.aborted ? 'failed' : (this.machine.stages.every((s) => s.status === 'done') ? 'ok' : 'failed')
    // Clear paused on terminal: a run can leave the loop while `paused` is still true (abort while
    // parked at the pause gate — abort() releases the gate but deliberately doesn't clear the flag).
    // A finished run must never surface as "paused" to the UI, so normalize it before the final
    // snapshot is emitted/persisted.
    this.paused = false
    this.deps.store.setContext('machine', this.machine)
    this.emitUpdate()
    return this.state
  }
}
