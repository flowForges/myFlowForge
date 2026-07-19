// src/main/run/controller.ts
import type { PermissionMode } from '@shared/permissions'
import type { AgentProvider, ConfirmReq, InputReq } from '../agents/types'
import type { ArtifactRef } from '../orchestrator/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { RunStore } from '../orchestrator/runStore'
import { initMachine, markRunning, currentStage, jumpBack, type RunPlan, type MachineState } from './machine'
import { applyGateDecision, type GateDecision, type LaneDecision } from './decisions'
import { addEvent, removeEvent, findEvent, type RunEvent } from './events'
import { addFeedback, editFeedback, removeFeedback, drainFeedback, type FeedbackDraft } from './feedback'
import { ResolverRegistry } from './resolver'
import { buildWorkOrders, type StageInput } from './fanout'
import { runWorkOrder, type WorkOrder, type WorkOrderOutcome } from './workOrder'
import { saveControllerState } from './persist'
import { mergeTempBranch as mergeTempBranchDefault, discardTempBranch as discardTempBranchDefault, parkTempBranch as parkTempBranchDefault } from './tempBranch'

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
  // Spec §8: "一次 run 绑定到发起它的会话" — the session that started this run, threaded straight
  // through from Run2StartOpts.sessionId (manager.ts) so the renderer can scope interaction cards
  // (gate/auth/question/doubt/failure) to that ONE session (WorkspaceView.tsx), mirroring the old
  // orchestrator's engine.run.sessionId pattern. Optional/absent for legacy or non-gate-launched runs
  // (raw run2:start / run2:start-workflow channels) — those show anywhere in the workspace, unchanged.
  sessionId?: string
  // P4-3: project name → its target branch, populated ONLY for a run whose participating projects
  // were actually checked out onto `plan.tempBranch` at start (see createRunTempBranches/P4-2,
  // wired in from run2Handlers.ts's run2:launch-start). ANY entry here turns on the run-completion
  // "收尾确认" finalize gate (see runFinalizeGate below); absent/empty (the raw run2:start /
  // run2:start-workflow channels, or a plain unit test's literal RunPlan) means this run has no
  // temp branch to reconcile, so it completes exactly as it did before P4-3 — no extra gate, no
  // test churn for every pre-existing controller test.
  projectTargets?: Record<string, string>
  // Injectable so tests never touch real git; default to the real tempBranch.ts functions.
  mergeTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
  discardTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
  // Finding 4 (Important — abort semantics), USER DECISION option B: an ABORTED run (mid-run 终止, or
  // 终止 while parked at the finalize gate) PARKS instead of discarding — see abortCleanup's doc.
  // Injectable for the same reason as merge/discardTempBranch above; defaults to the real
  // tempBranch.ts parkTempBranch.
  parkTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
}
export type RunStatus = 'running' | 'awaiting' | 'ok' | 'failed'
export interface LiveLane { stageKey: string; project?: string; state?: string; activity?: string; cwd?: string }
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
  // Set only on a finalize-gate merge/discard failure (see runFinalizeGate) — the readable,
  // per-project error message naming what actually failed (e.g. a merge conflict + file). Absent
  // for every other terminal path (ok, or a plain abort), so the renderer can distinguish "the
  // merge itself failed, here's why" from a generic failed status with no specific cause.
  error?: string
  // See RunControllerDeps.sessionId doc — copied verbatim onto state so renderer consumers (useRun2)
  // never need a separate channel just to learn which session owns this run.
  sessionId?: string
}

// P-C2/T1 (disk-resume): the shape RunController accepts to be reconstructed from a state loaded
// off disk (see persist.ts's loadControllerState) instead of a fresh initMachine(plan). Deliberately
// narrower than RunControllerState — two fields are NOT accepted, on purpose:
//  - `inbox` (pending gate/auth/question/failure/doubt events) is never restored. Every one of
//    those events has a live Promise sitting in THIS process's `laneR`/`gateR` ResolverRegistry —
//    the old process (and its resolvers) died with the app, so a restored event could never be
//    resolved by anything and would hang the UI forever. Rehydration always starts with an empty
//    inbox; the stage that was mid-flight (or parked awaiting a gate) simply re-runs from scratch
//    (see `sanitizeForResume` below) and raises whatever fresh events it needs this time around.
//  - `status`/`liveLanes` are always recomputed by start(), never taken from disk.
// `outcomes` IS accepted, but only in the SLIM on-disk shape persist.ts writes (id/status/project/
// error/attempts — no `result.summary`/`filesChanged`, see persist.ts's SavedOutcome) — restored
// only so `state.outcomes` (renderer history for already-`done` stages) has continuity across a
// resume. Resume's own logic never reads it back: buildPrompt's upstream() call reads
// `deps.store.getContext('artifacts:<stageKey>')` — ArtifactRef paths written by writeArtifact()
// and persisted in the SAME on-disk context.json that RunStore re-reads fresh from disk on every
// call (see runStore.ts's getContext/readContext) — so a downstream stage's prompt assembly after
// resume is correct even with `outcomes` entirely omitted (see controller.test.ts's file-vs-slim
// verification test).
export interface SlimOutcome { id: string; status: 'ok' | 'failed'; project?: string; error?: string; attempts: number }
export interface RehydrateState {
  machine: MachineState
  outcomes?: Record<string, SlimOutcome[]>
  feedback?: FeedbackDraft[]
  pendingDirective?: Record<string, string>
  stageTimings?: Record<string, { startedAt: number; endedAt?: number }>
}

// A loaded machine's currentIndex/statuses reflect whatever was on disk at the last emitUpdate()
// before the process died — for a clean stop that's exactly "first non-done stage" already, but a
// stage that was ACTUALLY mid-flight (its lanes running, or parked awaiting a gate decision) when
// the app died is normalized back to 'pending' here so it unambiguously re-runs from scratch on the
// next start() — its in-process lane/gate state (liveLanes, laneR/gateR resolvers) is gone, so
// there is nothing to "continue", only to redo (matches the plan's "只从完成的阶段续跑": a stage
// only counts as complete if it reached `done`). `currentIndex` is then recomputed from the
// (possibly just-changed) statuses rather than trusted verbatim off disk, as cheap defense against
// a stale/corrupt index. `plan` is taken from the constructor's own argument (not the loaded
// machine's embedded copy) so the freshly-supplied RunPlan — not a possibly-stale on-disk one — is
// what the rest of the controller (this.plan.stages lookups in buildPrompt etc.) actually runs.
function sanitizeForResume(plan: RunPlan, loaded: MachineState): MachineState {
  const stages = loaded.stages.map((s) =>
    (s.status === 'running' || s.status === 'awaiting-gate') ? { ...s, status: 'pending' as const } : { ...s })
  const idx = stages.findIndex((s) => s.status !== 'done')
  return { plan, stages, currentIndex: idx < 0 ? stages.length - 1 : idx }
}

// Reconstructs a placeholder WorkOrderOutcome from a slim on-disk outcome, for `state.outcomes`
// display continuity only (see RehydrateState's doc — this is NEVER read by resume's own prompt
// assembly). `result` is intentionally left undefined: the slim on-disk shape never carried it.
function placeholderOutcome(stageKey: string, o: SlimOutcome): WorkOrderOutcome {
  return {
    order: { id: o.id, stageKey, name: stageKey, project: o.project, provider: '', model: '', cwd: '', prompt: '' },
    status: o.status,
    error: o.error,
    attempts: o.attempts,
  }
}

export class RunController {
  private machine: MachineState
  private inbox: RunEvent[] = []
  private feedback: FeedbackDraft[] = []
  private outcomes: Record<string, WorkOrderOutcome[]> = {}
  private status: RunStatus = 'running'
  private error?: string
  private pendingDirective: Record<string, string> = {}
  private liveLanes: Record<string, LiveLane> = {}
  private stageTimings: Record<string, { startedAt: number; endedAt?: number }> = {}
  private aborted = false
  private paused = false
  // Set by requestJumpBack(), applied at the next stage boundary (see start()). Deliberately not
  // applied immediately — an in-flight stage's lanes must always finish uninterrupted, same
  // rationale as pause() (see its comment).
  private pendingJumpBack: string | null = null
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

  // `rehydrate` (P-C2/T1, disk-resume): when supplied, builds the controller from a state loaded
  // off disk instead of a fresh initMachine(plan) — see RehydrateState's doc for exactly what's
  // restored vs. deliberately dropped/recomputed. Omitted (the normal path) behaves exactly as
  // before this param existed.
  constructor(private plan: RunPlan, private deps: RunControllerDeps, rehydrate?: RehydrateState) {
    if (rehydrate) {
      this.machine = sanitizeForResume(plan, rehydrate.machine)
      this.feedback = rehydrate.feedback ?? []
      this.pendingDirective = rehydrate.pendingDirective ?? {}
      this.stageTimings = rehydrate.stageTimings ?? {}
      for (const [stageKey, list] of Object.entries(rehydrate.outcomes ?? {})) {
        this.outcomes[stageKey] = list.map((o) => placeholderOutcome(stageKey, o))
      }
    } else {
      this.machine = initMachine(plan)
    }
    this.makeId = deps.makeId ?? ((p) => `${p}-${this.idn++}`)
    this.now = deps.now ?? Date.now
  }

  onEvent(fn: (e: RunEvent) => void) { this.eventSubs.push(fn); return () => { this.eventSubs = this.eventSubs.filter((f) => f !== fn) } }
  onUpdate(fn: (s: RunControllerState) => void) { this.updateSubs.push(fn); return () => { this.updateSubs = this.updateSubs.filter((f) => f !== fn) } }
  // Separate subscription from onUpdate: log lines are broadcast live but never folded into
  // `state` and never persisted (see RunLogLine / emitLog below).
  onLog(fn: (l: RunLogLine) => void) { this.logSubs.push(fn); return () => { this.logSubs = this.logSubs.filter((f) => f !== fn) } }
  get state(): RunControllerState {
    return { machine: this.machine, inbox: [...this.inbox], feedback: [...this.feedback], outcomes: this.outcomes, status: this.status, pendingDirective: { ...this.pendingDirective }, liveLanes: { ...this.liveLanes }, stageTimings: { ...this.stageTimings }, paused: this.paused, error: this.error, sessionId: this.deps.sessionId }
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

  /**
   * Requests a mid-run rollback to an earlier, already-passed stage. Only records the request —
   * it's applied at the next stage boundary (start()'s loop top), same as pause(): an in-flight
   * stage's lanes are never interrupted. `targetKey` must name a stage strictly before the
   * current one (a real rollback, not a same-stage redo or a jump forward) or the request is
   * silently ignored — both here (fail fast on an obviously-bad request) and again when the
   * boundary actually applies it, since currentIndex may have moved by then.
   */
  requestJumpBack(targetKey: string): void {
    if (this.status !== 'running') return
    const idx = this.machine.stages.findIndex((s) => s.key === targetKey)
    if (idx < 0 || idx >= this.machine.currentIndex) return
    this.pendingJumpBack = targetKey
    this.emitUpdate()
  }

  /**
   * The "design stage" a doubt's 回退改方案 jumps back to when the caller doesn't supply an
   * explicit targetKey (the doubt-resolution UI is a single button, no stage picker). Per
   * spec §7.7, the design/方案 stage is the one gated "方案通过后、动代码前" — approximated here
   * as the plan's FIRST gated stage; if the plan has no gated stage at all (unusual), fall back
   * to the very first stage so jumpBack always has a valid target.
   */
  private designStageKey(): string {
    const gated = this.plan.stages.find((s) => s.gate)
    return (gated ?? this.plan.stages[0]).key
  }

  /**
   * P4-3 收尾确认: called once, right after the main stage loop breaks with EVERY stage `done` (never
   * on abort — see start()'s call site, which only reaches this when `!this.aborted`). jumpBack never
   * touches git at all — a mid-run jump back to an earlier stage just re-runs stages, still on the
   * same temp branch, nothing to reconcile yet. abort() PARKS (see abortCleanup's doc) rather than
   * merging or discarding; this finalize gate remains the ONE place a run's temp branch gets merged
   * or discarded (Finding 5).
   *
   * No-ops entirely (returns immediately) when `deps.projectTargets` has no entries matching
   * `deps.projects` — i.e. this run was never checked out onto a real temp branch (see
   * RunControllerDeps.projectTargets doc), so there is nothing to reconcile and the run completes
   * exactly as it did before this gate existed.
   *
   * Otherwise emits a GateEvent with `finalize: true` (reusing the 'gate' kind/resolveGate/gateR
   * machinery — see events.ts/decisions.ts) and awaits its decision:
   *   - `merge`   → mergeTempBranch(cwd, target, runId) for every participating project.
   *   - `discard` → discardTempBranch(cwd, target, runId) for every participating project.
   *   - anything else (only reachable via abort()'s settleAll force-resolving every pending
   *     gate/lane with `{type:'advance'}` — see resolveLane/abort) → PARKS instead (abortCleanup),
   *     same as any other abort; the run ends failed, but the work is preserved on the temp branch.
   *
   * Per-project failures are collected (not stopped at the first one, so one bad repo doesn't block
   * the rest from finishing) and re-thrown together as a single readable Error naming every failed
   * project — this propagates out of start() and is caught by Run2Manager's existing
   * `.catch(...) → status 'failed'` handling (the same path a zero-work-orders throw already takes),
   * so a merge conflict surfaces as a clear failure instead of silently vanishing or crashing the
   * manager.
   */
  /**
   * The `{ name, cwd, target }` list every project actually checked out onto this run's temp
   * branch — shared by runFinalizeGate (merge/discard) and abortCleanup (park-on-abort) so
   * both act on exactly the same set of repos. Empty when this run never touched a temp branch
   * (see RunControllerDeps.projectTargets doc) — both callers no-op in that case.
   */
  private finalizeTargets(): Array<{ name: string; cwd: string; target: string }> {
    return this.deps.projects
      .map((p) => ({ name: p.name, cwd: p.cwd, target: this.deps.projectTargets?.[p.name] }))
      .filter((t): t is { name: string; cwd: string; target: string } => !!t.target)
  }

  /**
   * Finding 4 (Important — abort semantics), USER DECISION option B (preserve): an aborted run
   * (mid-run 终止, or 终止 while parked at the finalize gate) must NOT destroy the agent's
   * in-progress work — it PARKS every participating project instead: commit whatever's dirty onto
   * the temp branch, then checkout the target (now clean), and KEEP the temp branch (no delete, no
   * `clean -fd`). The work stays recoverable on `forge/run-<runId>`. Reuses parkTempBranch's exact
   * semantics via the same injectable dep so tests never touch real git.
   *
   * Best-effort per project: an aborted run must not itself crash because cleanup for one repo
   * failed (e.g. the temp branch already gone) — collect failures via console.error and move on,
   * rather than throwing and turning a clean abort into a confusing failure-with-stack-trace.
   */
  private async abortCleanup(): Promise<void> {
    const targets = this.finalizeTargets()
    if (targets.length === 0) return
    const park = this.deps.parkTempBranch ?? parkTempBranchDefault
    for (const t of targets) {
      try {
        await park(t.cwd, t.target, this.plan.runId)
      } catch (err) {
        console.error(`[run2] abort cleanup failed for project "${t.name}" (target "${t.target}"):`, err)
      }
    }
  }

  private async runFinalizeGate(): Promise<void> {
    const targets = this.finalizeTargets()
    if (targets.length === 0) return

    const id = this.makeId('gate')
    this.status = 'awaiting'
    const p = this.gateR.create(id)
    this.emitEvent({ id, kind: 'gate', stageKey: '__finalize__', body: '全部完成，合并到目标分支？', finalize: true })
    const d = await p
    this.drop(id)
    this.emitUpdate()

    if (this.aborted) {
      // 终止 while parked at this gate (abort()'s settleAll force-resolves it with
      // `{type:'advance'}` — see resolveLane/abort) — same "park, preserve the work" contract as
      // any other abort path (see abortCleanup's doc).
      await this.abortCleanup()
      return
    }
    if (d.type !== 'merge' && d.type !== 'discard') return

    const merge = d.type === 'merge'
    const action = merge
      ? (this.deps.mergeTempBranch ?? mergeTempBranchDefault)
      : (this.deps.discardTempBranch ?? discardTempBranchDefault)
    const failures: string[] = []
    for (const t of targets) {
      try {
        await action(t.cwd, t.target, this.plan.runId)
      } catch (err) {
        failures.push(`${t.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (failures.length > 0) {
      // Recorded on the controller (not just thrown) so the terminal RunControllerState carries
      // the real, readable per-project failure — Run2Manager's `.catch` only overrides `status`
      // to 'failed', it never had a way to surface *why*; the renderer must show this instead of
      // guessing at a generic "failed stage" message (see RunExecPanel).
      const message = `${merge ? '合并' : '丢弃'}临时分支失败 — ${failures.join('; ')}`
      this.error = message
      throw new Error(message)
    }
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
          cwd: order.cwd,
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
      // Jump-back gate: applied here, at the stage boundary, before the next stage is read/started
      // — same in-flight-safety rationale as the pause gate above. Re-validate against the current
      // machine (currentIndex may have moved since requestJumpBack() was called, e.g. a paused run
      // resumed and advanced further before this check ever ran).
      if (this.pendingJumpBack) {
        const target = this.pendingJumpBack
        this.pendingJumpBack = null
        const idx = this.machine.stages.findIndex((s) => s.key === target)
        if (idx >= 0 && idx < this.machine.currentIndex) {
          this.machine = jumpBack(this.machine, target)
          this.emitUpdate()
        }
      }
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
      //
      // Deliberately NOT clearing `this.pendingDirective[stage.key]` here (P-C2/T1 review Finding 1,
      // Critical, empirically reproduced): buildWorkOrders() above already READ it (via buildPrompt)
      // to build THIS round's prompt, so clearing looked like harmless "consumed" bookkeeping — but
      // the gate/doubt/failure-retry awaits for *this same round* haven't happened yet, and that's
      // exactly where the app is most likely to die (user reviewing a redo's gate). If it dies there,
      // the on-disk pendingDirective is already '' even though `round` is still >0; on resume the
      // stage re-runs FROM SCRATCH (sanitizeForResume never resumes mid-round) and buildPrompt reads
      // the now-empty directive — the user's redo feedback is silently dropped, and the resumed
      // re-run behaves as if it were a fresh (non-redo) round. It's safe to just leave the value in
      // place: nothing re-reads a stale directive without an explicit fresh write immediately before
      // it matters — a `redo` decision overwrites `pendingDirective[stage.key]` (below) and a
      // `jumpBack` decision unconditionally overwrites `pendingDirective[targetKey]` (below, and in
      // the doubt-handling block), even with an empty string when there's no new feedback. So the
      // only stage that ever reads a directive is one whose own most recent redo/jumpBack decision
      // just set it — there is no path where a stale, no-longer-relevant value leaks into a prompt.
      let outcomes = await Promise.all(orders.map((o) => this.runOneOrder(o)))

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
      // Resolvers are created HERE, at emission time (same create-before-emit ordering as
      // onConfirm/onInput/failure above), and awaited later — right before the machine actually
      // advances — so a doubt can hold the stage even if the gate below has already resolved.
      const doubtWaits: Array<Promise<{ id: string; note: string; d: LaneDecision }>> = []
      for (const oc of outcomes) {
        if (oc.status === 'ok' && oc.result) {
          const ref = this.deps.store.writeArtifact(`${stage.key}-${oc.order.project ?? 'root'}.md`, oc.result.summary)
          refs.push(ref)
          for (const doubt of oc.result.doubts) {
            const id = this.makeId('doubt')
            const p = this.laneR.create(id)
            this.emitEvent({ id, kind: 'doubt', laneId: oc.order.id, stageKey: stage.key, note: doubt })
            doubtWaits.push(p.then((d) => ({ id, note: doubt, d })))
          }
        }
      }
      this.deps.store.setContext('artifacts:' + stage.key, refs)
      this.outcomes[stage.key] = outcomes
      if (this.stageTimings[stage.key]) this.stageTimings[stage.key].endedAt = this.now()

      // gate or auto-advance: this decides what WOULD happen next. Unresolved doubts don't block
      // answering the gate itself (§7.2 — "冒泡存疑，兄弟继续"); they block applying the result
      // (see below).
      let d: GateDecision
      if (stage.gate) {
        const id = this.makeId('gate')
        const body = refs.map((r) => r.path).join('\n')
        this.status = 'awaiting'
        const p = this.gateR.create(id)
        this.emitEvent({ id, kind: 'gate', stageKey: stage.key, body, docs: refs })
        d = await p
        this.drop(id)
        if (this.aborted) {
          // force-settled by a concurrent lane abort; don't advance the machine. The doubt
          // resolvers above were created BEFORE this gate and share the same abort-triggered
          // settleAll() (see resolveLane/abort), so they're already settled — but nothing has
          // consumed/dropped them yet since we're breaking out before reaching the doubt-drain
          // block below. Drain them here so no orphaned doubt event survives in the inbox
          // (same rationale as the failure-loop drain above).
          if (doubtWaits.length > 0) {
            const resolved = await Promise.all(doubtWaits)
            for (const { id } of resolved) this.drop(id)
            this.emitUpdate()
          }
          break
        }
        if (d.type === 'redo') {
          const { text, drained } = drainFeedback(this.feedback); this.feedback = drained
          this.pendingDirective[stage.key] = [text, d.feedback].filter(Boolean).join('\n')
        } else if (d.type === 'jumpBack') {
          const { text, drained } = drainFeedback(this.feedback); this.feedback = drained
          this.pendingDirective[d.targetKey] = [text, d.feedback].filter(Boolean).join('\n')
        }
      } else {
        d = { type: 'advance' }
      }

      // Doubt gate (§7.2/§7.7 P3-3): a stage must HOLD — never actually advance — while an
      // unresolved doubt event exists for it, even if the gate above already said "advance".
      // Await every doubt's resolution now; each one dispatches to one of four actions:
      //   - dismiss     (驳回继续)   → drop it, `d` (the gate's decision) applies unchanged.
      //   - redo        (补充说明后继续) → overrides `d` to redo the CURRENT stage, with the
      //                                    doubt's note + the human's clarification threaded in
      //                                    as this stage's pendingDirective (picked up by
      //                                    buildPrompt on the next run).
      //   - jumpBack    (回退改方案)  → overrides `d` to jump back to the design stage (explicit
      //                                    targetKey if the caller supplied one, else the plan's
      //                                    first gated stage / first stage — see designStageKey()).
      //   - abort       (终止运行)   → stops the run like any other abort path.
      // A later-resolved doubt's override wins if multiple doubts fired for this stage; each is
      // still individually dropped from the inbox regardless of which one "wins".
      if (doubtWaits.length > 0) {
        this.status = 'awaiting'
        const resolved = await Promise.all(doubtWaits)
        for (const { id, note, d: ld } of resolved) {
          this.drop(id)
          if (ld.type === 'abort') { this.aborted = true; continue }
          if (this.aborted || ld.type === 'dismiss') continue
          const { text, drained } = drainFeedback(this.feedback); this.feedback = drained
          if (ld.type === 'redo') {
            this.pendingDirective[stage.key] = [note, ld.feedback, text].filter(Boolean).join('\n')
            d = { type: 'redo' }
          } else if (ld.type === 'jumpBack') {
            const target = ld.targetKey ?? this.designStageKey()
            this.pendingDirective[target] = [note, ld.feedback, text].filter(Boolean).join('\n')
            d = { type: 'jumpBack', targetKey: target }
          }
        }
        this.emitUpdate()
      }
      if (this.aborted) break

      this.machine = applyGateDecision(this.machine, d)
      this.emitUpdate()
      if (this.machine.stages.every((s) => s.status === 'done')) break
    }

    // P4-3: only reached on a genuine full-plan completion — never on abort (the loop above always
    // `break`s with `this.aborted` true first on any abort path, before this line). May throw (a
    // merge/discard failure) — that's intentional, see runFinalizeGate's doc.
    if (!this.aborted && this.machine.stages.every((s) => s.status === 'done')) {
      await this.runFinalizeGate()
    } else if (this.aborted) {
      // I1: a MID-run abort (loop above `break`s before ever reaching runFinalizeGate) still left
      // whatever project(s) were checked out onto this run's temp branch dirty/mid-run — park them
      // here (commit + checkout target, temp branch kept) so 终止 always leaves every target branch
      // clean WITHOUT destroying the agent's work, matching the 终止-at-the-finalize-gate path
      // handled inside runFinalizeGate itself. Best-effort, see abortCleanup's doc — never lets a
      // cleanup failure turn a clean abort into a thrown error.
      await this.abortCleanup()
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
