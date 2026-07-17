// src/main/run/controller.ts
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
}
export type RunStatus = 'running' | 'awaiting' | 'ok' | 'failed'
export interface RunControllerState {
  machine: MachineState
  inbox: RunEvent[]
  feedback: FeedbackDraft[]
  outcomes: Record<string, WorkOrderOutcome[]>
  status: RunStatus
  pendingDirective: Record<string, string>
}

export class RunController {
  private machine: MachineState
  private inbox: RunEvent[] = []
  private feedback: FeedbackDraft[] = []
  private outcomes: Record<string, WorkOrderOutcome[]> = {}
  private status: RunStatus = 'running'
  private pendingDirective: Record<string, string> = {}
  private aborted = false
  private laneR = new ResolverRegistry<LaneDecision>()
  private gateR = new ResolverRegistry<GateDecision>()
  private eventSubs: Array<(e: RunEvent) => void> = []
  private updateSubs: Array<(s: RunControllerState) => void> = []
  private idn = 0
  private makeId: (p: string) => string

  constructor(private plan: RunPlan, private deps: RunControllerDeps) {
    this.machine = initMachine(plan)
    this.makeId = deps.makeId ?? ((p) => `${p}-${this.idn++}`)
  }

  onEvent(fn: (e: RunEvent) => void) { this.eventSubs.push(fn); return () => { this.eventSubs = this.eventSubs.filter((f) => f !== fn) } }
  onUpdate(fn: (s: RunControllerState) => void) { this.updateSubs.push(fn); return () => { this.updateSubs = this.updateSubs.filter((f) => f !== fn) } }
  get state(): RunControllerState {
    return { machine: this.machine, inbox: [...this.inbox], feedback: [...this.feedback], outcomes: this.outcomes, status: this.status, pendingDirective: { ...this.pendingDirective } }
  }
  private emitEvent(e: RunEvent) { this.inbox = addEvent(this.inbox, e); for (const f of this.eventSubs) f(e); this.emitUpdate() }
  private drop(id: string) { this.inbox = removeEvent(this.inbox, id) }
  private emitUpdate() { const s = this.state; for (const f of this.updateSubs) f(s); saveControllerState(this.deps.store, s) }

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
    this.emitUpdate()
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
    const up = o.upstream.length ? `\n上游产物：\n${o.upstream.map((a) => `- ${a.path} (${a.kind})`).join('\n')}` : ''
    const dir = this.pendingDirective[o.stageKey] ? `\n【补充/返工意见】\n${this.pendingDirective[o.stageKey]}` : ''
    return `【阶段】${o.stageKey}${o.project ? `（项目 ${o.project}）` : ''}\ncwd=${o.cwd}${up}${dir}\n回传结构化结果。`
  }

  private async runOneOrder(order: WorkOrder): Promise<WorkOrderOutcome> {
    return runWorkOrder(order, {
      provider: this.deps.providers[order.provider],
      env: this.deps.env,
      retries: this.deps.retries,
      sleep: this.deps.sleep,
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
      const cur = currentStage(this.machine)
      if (!cur || cur.status === 'done') break
      this.machine = markRunning(this.machine); this.status = 'running'; this.emitUpdate()
      const idx = this.machine.currentIndex
      const stage = this.plan.stages[idx]
      const input: StageInput = {
        stage: { ...stage },
        workspacePath: this.workspacePath(),
        projects: this.deps.projects,
        upstream: this.upstream(idx),
        buildPrompt: this.buildPrompt,
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
    this.deps.store.setContext('machine', this.machine)
    this.emitUpdate()
    return this.state
  }
}
