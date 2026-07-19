import type { PermissionMode } from '@shared/permissions'
import type { AgentProvider } from '../agents/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { RunStore } from '../orchestrator/runStore'
import { RunController, type RunControllerState, type RunLogLine } from './controller'
import type { RunPlan } from './machine'
import type { GateDecision, LaneDecision } from './decisions'
import type { RunEvent } from './events'
import { discardResumableRun, findLatestRun2Run, isTerminalStatus, type SavedControllerState } from './persist'

export interface Run2Emit {
  event(wsPath: string, e: RunEvent): void
  update(wsPath: string, s: RunControllerState): void
  // Optional: existing manager tests that build `emit` without `log` must still compile/pass.
  log?: (wsPath: string, log: RunLogLine) => void
  // Optional (Task 1 queue): broadcasts a workspace's pending-queue length whenever it changes
  // (enqueue or dequeue). Optional so existing manager tests that build `emit` without it keep passing.
  queue?: (wsPath: string, info: { length: number }) => void
}
export interface Run2StartOpts {
  workspacePath: string; runId: string; plan: RunPlan; projects: DevelopProject[]; task?: string; permissionMode?: PermissionMode
  // Spec §8: the session that started this run — threaded straight into RunControllerDeps.sessionId
  // (see its doc in controller.ts) so the renderer can scope interaction cards (gate/auth/question/
  // doubt/failure) to the OWNING session only. Optional — absent for legacy/direct-start callers.
  sessionId?: string
  // P4-3: threaded straight through into RunControllerDeps — see its doc in controller.ts. Only
  // run2:launch-start (the one channel that actually checks projects out onto a real temp branch,
  // P4-2) populates these; every other caller omits them and the finalize gate stays off.
  projectTargets?: Record<string, string>
  mergeTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
  discardTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
  // Finding 4 (Important — abort semantics): the abort path parks instead of discarding — see its
  // doc in controller.ts. Threaded through the same way as merge/discardTempBranch above.
  parkTempBranch?: (cwd: string, target: string, runId: string) => Promise<void>
}
export interface Run2ManagerDeps {
  providers: Record<string, AgentProvider>
  env: NodeJS.ProcessEnv
  makeStore: (wsPath: string, runId: string) => RunStore
  emit: Run2Emit
  retries?: number
  onError?: (wsPath: string, err: Error) => void
  // §7.4 ③硬阻塞: threaded straight into RunControllerDeps.mcpEntry (see its doc in controller.ts) —
  // handlers.ts's `join(__dirname, 'forgeMcp.js')`, the same entry the legacy Orchestrator and
  // chat/delegate.ts already use. Optional so every existing manager test (none set it) keeps
  // passing unchanged — an unset mcpEntry just means runs from this manager never open a live forge
  // bridge, same as before this field existed.
  mcpEntry?: string
}

// Task 1: start() used to throw when the workspace already had a run in flight. It now enqueues instead
// — the union return lets callers (run2Handlers → renderer) distinguish "started right away" from
// "queued behind another run", carrying the queued run's 1-based position.
export type Run2StartResult =
  | { status: 'started'; state: RunControllerState }
  | { status: 'queued'; position: number }

// P-C2/T2 (disk-resume): everything resumeFromDisk() needs that a fresh start() gets from
// Run2StartOpts but disk-resume can't get from there (no launch call happened this process) —
// `workspacePath`/`runId`/`plan` are dropped because resume derives them itself (workspacePath is
// already the method's own argument; runId + the full RunPlan — including its stamped tempBranch,
// see machine.ts's RunPlan/planFromStages — are read back off disk via findLatestRun2Run, NOT
// rebuilt from the workspace's current launch config, which no longer exists in this process).
// `projects` stays required here as a FALLBACK, not the source of truth: resumeFromDisk below
// prefers the on-disk snapshot's own `state.projects` (P-C2/T3 review Finding 1, CRITICAL — the
// EXACT gate-selected subset the original run was launched with, persisted by saveControllerState —
// see its doc in persist.ts) and only falls back to this caller-supplied value for an OLDER saved
// state written before `projects` was persisted at all. The T3 IPC handler still builds and passes
// this as "every project on the workspace" for that legacy fallback path.
export type Run2ResumeOpts = Omit<Run2StartOpts, 'workspacePath' | 'runId' | 'plan'>

// What the UI shows before offering "continue this run?" after an app restart — see
// Run2Manager.resumable() below. `workflowName` is deliberately always absent: RunPlan (the thing
// saved to disk) has no name field, only stage keys/prompts, so there is nothing to derive one from
// without adding new persistence — left optional for whenever a caller has a name from elsewhere.
export interface ResumableSummary {
  runId: string
  workflowName?: string
  resumeStageKey: string
  resumeStageName: string
  totalStages: number
  doneCount: number
}

function summarizeResumable(runId: string, state: SavedControllerState): ResumableSummary {
  const stages = state.machine.stages
  const doneCount = stages.filter((s) => s.status === 'done').length
  const idx = stages.findIndex((s) => s.status !== 'done')
  const resumeStage = stages[idx] ?? stages[stages.length - 1]
  const stagePlan = state.machine.plan.stages.find((s) => s.key === resumeStage?.key)
  return {
    runId,
    resumeStageKey: resumeStage?.key ?? '',
    resumeStageName: stagePlan?.name ?? resumeStage?.key ?? '',
    totalStages: stages.length,
    doneCount,
  }
}

export class Run2Manager {
  private controllers = new Map<string, RunController>()
  // Additive: retains the terminal state of the most recently *completed* run per workspace, so the
  // renderer's run2:get-state can still show a finished run's outcomes/status after the controller is
  // removed from `controllers` (which frees the serial lock but would otherwise lose the final state).
  private lastState = new Map<string, RunControllerState>()
  // Task 1: FIFO queue of runs waiting for a busy workspace's serial lock to free up. Drained one at a
  // time from `startNext`, called from the active run's `.finally` (after the lock is released).
  private queues = new Map<string, Run2StartOpts[]>()
  constructor(private deps: Run2ManagerDeps) {}

  start(opts: Run2StartOpts): Run2StartResult {
    if (this.controllers.has(opts.workspacePath)) {
      const queue = this.queues.get(opts.workspacePath) ?? []
      queue.push(opts)
      this.queues.set(opts.workspacePath, queue)
      this.emitQueue(opts.workspacePath)
      return { status: 'queued', position: queue.length }
    }
    const state = this.startNow(opts)
    return { status: 'started', state }
  }

  private emitQueue(wsPath: string): void {
    this.deps.emit.queue?.(wsPath, { length: this.queues.get(wsPath)?.length ?? 0 })
  }

  // Drains the next queued run (if any) for a workspace whose lock was JUST freed. Called from the
  // outgoing run's `.finally`, after `this.controllers.delete(wsPath)`. try/catch: `this.start(next)`
  // only *creates* the controller and kicks off its async `.start()` — it can still throw synchronously
  // (e.g. `makeStore`/`RunController` construction). A synchronous throw here would otherwise escape into
  // the `.finally` callback of the run that just finished, becoming an unhandled rejection on that
  // discarded (`void ...`) promise chain and — worse — silently stalling every run still behind it in the
  // queue. On catch we route the failure through the normal onError channel and recurse to try the next
  // queued item, so one bad entry can't wedge the rest. Recursion is bounded: each call either takes the
  // lock (stops recursing) or shifts an item off a finite queue, so it always terminates.
  private startNext(wsPath: string): void {
    try {
      const queue = this.queues.get(wsPath)
      if (!queue || queue.length === 0) return
      const next = queue.shift()!
      if (queue.length === 0) this.queues.delete(wsPath)
      this.emitQueue(wsPath)
      this.start(next)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.deps.onError?.(wsPath, e)
      this.startNext(wsPath)
    }
  }

  private startNow(opts: Run2StartOpts): RunControllerState {
    const store = this.deps.makeStore(opts.workspacePath, opts.runId)
    // Default: an unset permissionMode defaults to 'full' here (not 'auto'/sandboxed) — a real run
    // showed codex needs full to write files without the sandbox cancelling its MCP calls. This is
    // the single default point for BOTH run2 start paths (the raw run2:start-stages channel and the
    // run2:start-workflow launcher), so any caller can still override it explicitly.
    const controller = new RunController(opts.plan, {
      providers: this.deps.providers, store, env: this.deps.env,
      projects: opts.projects, retries: this.deps.retries, task: opts.task,
      permissionMode: opts.permissionMode ?? 'full',
      sessionId: opts.sessionId,
      projectTargets: opts.projectTargets,
      mergeTempBranch: opts.mergeTempBranch,
      discardTempBranch: opts.discardTempBranch,
      parkTempBranch: opts.parkTempBranch,
      mcpEntry: this.deps.mcpEntry,
    })
    return this.registerAndRun(opts.workspacePath, controller)
  }

  // Shared by startNow() (fresh RunController from a launch config) and resumeFromDisk() (P-C2/T2 —
  // a RunController rehydrated from the on-disk snapshot of an interrupted run): wires the
  // event/update/log bridges, takes the per-workspace serial lock, kicks off the async start()
  // loop, and releases the lock (+ dequeues the next queued run) once it settles either way.
  private registerAndRun(wsPath: string, controller: RunController): RunControllerState {
    // A (re)started run supersedes whatever finished-run state was retained from a prior run in
    // this workspace.
    this.lastState.delete(wsPath)
    controller.onEvent((e) => this.deps.emit.event(wsPath, e))
    controller.onUpdate((s) => this.deps.emit.update(wsPath, s))
    controller.onLog((l) => this.deps.emit.log?.(wsPath, l))
    this.controllers.set(wsPath, controller)
    // .catch prevents an unhandled rejection (e.g. RunController.start()'s zero-work-orders throw)
    // from crashing the Electron main process; .finally frees the per-workspace serial lock.
    // `caughtFailedState` lets .finally know whether .catch already produced the authoritative terminal
    // snapshot — controller.state itself is never mutated to 'failed' by .catch (only the emitted copy
    // is), so .finally must not blindly overwrite it with the (still 'running') live controller.state.
    let caughtFailedState: RunControllerState | null = null
    void controller
      .start()
      .catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err))
        this.deps.onError?.(wsPath, e)
        // ensure the renderer receives a terminal transition even when start() throws before its own
        // terminal emit (e.g. the zero-work-orders guard) — otherwise it's stuck on 'running' forever.
        caughtFailedState = { ...controller.state, status: 'failed' }
        this.deps.emit.update(wsPath, caughtFailedState)
      })
      .finally(() => {
        // Snapshot the final state before dropping the controller from the active map, so a finished
        // (ok/failed) run is still retrievable via lastStateFor() after the serial lock is freed.
        this.lastState.set(wsPath, caughtFailedState ?? controller.state)
        this.controllers.delete(wsPath)
        // Task 1: the lock is now free — dequeue+start whatever's next for this workspace, if anything.
        // Must run AFTER the delete above, since start()/startNow() re-checks `controllers.has(wsPath)`.
        this.startNext(wsPath)
      })
    return controller.state
  }

  // P-C2/T2: what the UI queries (e.g. on workspace open) to learn whether a workflow was mid-run
  // when the app last died. Returns null when there's nothing to offer: no saved state at all, a
  // saved state that already reached a TERMINAL status (ok/failed — a run that finished cleanly,
  // or already got a manager-level failure snapshot, is not "interrupted"), or — importantly — a
  // workspace that already has a LIVE controller in memory (a run that's actually still going,
  // e.g. this same process resumed it already, or it was started fresh this session) — disk-resume
  // is only for a run that died with no process left driving it.
  resumable(wsPath: string): ResumableSummary | null {
    if (this.controllers.has(wsPath)) return null
    const found = findLatestRun2Run(wsPath)
    if (!found || isTerminalStatus(found.state.status)) return null
    return summarizeResumable(found.runId, found.state)
  }

  // P-C2/T2: rebuilds a RunController from the on-disk snapshot of an interrupted run (same runId —
  // this CONTINUES that run, it does not start a new one) via RunController's rehydrate path (T1;
  // see controller.ts's RehydrateState/sanitizeForResume), then registers + starts it exactly like
  // a fresh run — resume from the first non-`done` stage happens inside start() itself.
  //
  // Deliberately throws (rather than start()'s enqueue-behind-the-active-run) when the workspace
  // already has a live controller: queuing a disk-resume behind an already-running controller makes
  // no sense — resumable() would have returned null for this workspace in the first place, so a
  // caller reaching here despite that has a stale/racy view of the world and should be told loudly,
  // not have its resume silently queued behind a run it didn't know was live. Same handling for "no
  // resumable state" (already terminal, or was never saved) — resumable() is the intended
  // pre-check; resumeFromDisk() re-validates rather than trusting a caller's possibly-stale summary.
  resumeFromDisk(wsPath: string, opts: Run2ResumeOpts): RunControllerState {
    if (this.controllers.has(wsPath)) {
      throw new Error(`Run2Manager.resumeFromDisk: workspace already has an active run: ${wsPath}`)
    }
    const found = findLatestRun2Run(wsPath)
    if (!found || isTerminalStatus(found.state.status)) {
      throw new Error(`Run2Manager.resumeFromDisk: no resumable run for workspace: ${wsPath}`)
    }
    const store = this.deps.makeStore(wsPath, found.runId)
    const plan = found.state.machine.plan
    // P-C2/T3 review Finding 1 (CRITICAL): the persisted state's OWN `projects` — the exact
    // gate-selected subset the original run was launched with — wins over the caller's
    // `opts.projects` (which the T3 IPC handler builds as "every project on the workspace", a
    // legacy-fallback reconstruction, not authoritative). Only when the saved state predates this
    // field (`undefined` — see persist.ts's SavedControllerState.projects doc) do we fall back to
    // whatever the caller supplied, same as before this fix existed. Getting this wrong is exactly
    // what let a still-pending per-project stage resume against a project the original run never
    // selected — one never checked out onto the run's temp branch — corrupting its real branch at
    // the finalize gate (finalizeTargets() in controller.ts maps over THIS array).
    const projects = found.state.projects ?? opts.projects
    const controller = new RunController(plan, {
      providers: this.deps.providers, store, env: this.deps.env,
      projects, retries: this.deps.retries,
      // P-C2/T3 (Finding 2): recovered off the saved state itself when the resume caller doesn't
      // supply an explicit override — see SavedControllerState.sessionId/.task doc (persist.ts) for
      // why these are persisted at all. An explicit opts value (if a future caller ever has one)
      // still wins, same precedence as every other opts field here.
      task: opts.task ?? found.state.task,
      permissionMode: opts.permissionMode ?? 'full',
      sessionId: opts.sessionId ?? found.state.sessionId,
      projectTargets: opts.projectTargets,
      mergeTempBranch: opts.mergeTempBranch,
      discardTempBranch: opts.discardTempBranch,
      parkTempBranch: opts.parkTempBranch,
      mcpEntry: this.deps.mcpEntry,
    }, {
      machine: found.state.machine,
      outcomes: found.state.outcomes,
      feedback: found.state.feedback,
      pendingDirective: found.state.pendingDirective,
      stageTimings: found.state.stageTimings,
      laneTimings: found.state.laneTimings,
    })
    return this.registerAndRun(wsPath, controller)
  }

  // P-C2/T3: the recovery UI's 丢弃 action — clears the on-disk state so resumable() stops offering
  // it. Same "not while a controller is live" gating as resumable()/resumeFromDisk() (a workspace
  // with a live controller has nothing stale on disk to discard — either it was just resumed, or a
  // fresh run has since superseded whatever old state was there).
  discardResumable(wsPath: string): boolean {
    if (this.controllers.has(wsPath)) return false
    return discardResumableRun(wsPath)
  }
  get(wsPath: string): RunController | undefined { return this.controllers.get(wsPath) }
  isActive(wsPath: string): boolean { return this.controllers.has(wsPath) }
  // Additive: the retained terminal state of the most recently completed run in this workspace (null if
  // never run, or if a new run has since started and superseded it). See `lastState` field comment.
  lastStateFor(wsPath: string): RunControllerState | null { return this.lastState.get(wsPath) ?? null }
  resolveGate(wsPath: string, eventId: string, d: GateDecision): boolean { return this.controllers.get(wsPath)?.resolveGate(eventId, d) ?? false }
  resolveLane(wsPath: string, eventId: string, d: LaneDecision): boolean { return this.controllers.get(wsPath)?.resolveLane(eventId, d) ?? false }
  addFeedback(wsPath: string, text: string): void { this.controllers.get(wsPath)?.addFeedback(text) }
  editFeedback(wsPath: string, id: string, text: string): void { this.controllers.get(wsPath)?.editFeedback(id, text) }
  removeFeedback(wsPath: string, id: string): void { this.controllers.get(wsPath)?.removeFeedback(id) }
  abort(wsPath: string): void { this.controllers.get(wsPath)?.abort() }
  pause(wsPath: string): void { this.controllers.get(wsPath)?.pause() }
  resume(wsPath: string): void { this.controllers.get(wsPath)?.resume() }
  requestJumpBack(wsPath: string, targetKey: string): void { this.controllers.get(wsPath)?.requestJumpBack(targetKey) }
}
