import type { PermissionMode } from '@shared/permissions'
import type { AgentProvider } from '../agents/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { RunStore } from '../orchestrator/runStore'
import { RunController, type RunControllerState, type RunLogLine } from './controller'
import type { RunPlan } from './machine'
import type { GateDecision, LaneDecision } from './decisions'
import type { RunEvent } from './events'

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
  // Optional (Task 1 queue): who queued this run, for future display purposes. Not read internally —
  // purely additive passthrough so callers can attach it without affecting behavior.
  sessionId?: string
}
export interface Run2ManagerDeps {
  providers: Record<string, AgentProvider>
  env: NodeJS.ProcessEnv
  makeStore: (wsPath: string, runId: string) => RunStore
  emit: Run2Emit
  retries?: number
  onError?: (wsPath: string, err: Error) => void
}

// Task 1: start() used to throw when the workspace already had a run in flight. It now enqueues instead
// — the union return lets callers (run2Handlers → renderer) distinguish "started right away" from
// "queued behind another run", carrying the queued run's 1-based position.
export type Run2StartResult =
  | { status: 'started'; state: RunControllerState }
  | { status: 'queued'; position: number }

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
    // A new run supersedes whatever finished-run state was retained from a prior run in this workspace.
    this.lastState.delete(opts.workspacePath)
    const store = this.deps.makeStore(opts.workspacePath, opts.runId)
    // Default: an unset permissionMode defaults to 'full' here (not 'auto'/sandboxed) — a real run
    // showed codex needs full to write files without the sandbox cancelling its MCP calls. This is
    // the single default point for BOTH run2 start paths (the raw run2:start-stages channel and the
    // run2:start-workflow launcher), so any caller can still override it explicitly.
    const controller = new RunController(opts.plan, {
      providers: this.deps.providers, store, env: this.deps.env,
      projects: opts.projects, retries: this.deps.retries, task: opts.task,
      permissionMode: opts.permissionMode ?? 'full',
    })
    controller.onEvent((e) => this.deps.emit.event(opts.workspacePath, e))
    controller.onUpdate((s) => this.deps.emit.update(opts.workspacePath, s))
    controller.onLog((l) => this.deps.emit.log?.(opts.workspacePath, l))
    this.controllers.set(opts.workspacePath, controller)
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
        this.deps.onError?.(opts.workspacePath, e)
        // ensure the renderer receives a terminal transition even when start() throws before its own
        // terminal emit (e.g. the zero-work-orders guard) — otherwise it's stuck on 'running' forever.
        caughtFailedState = { ...controller.state, status: 'failed' }
        this.deps.emit.update(opts.workspacePath, caughtFailedState)
      })
      .finally(() => {
        // Snapshot the final state before dropping the controller from the active map, so a finished
        // (ok/failed) run is still retrievable via lastStateFor() after the serial lock is freed.
        this.lastState.set(opts.workspacePath, caughtFailedState ?? controller.state)
        this.controllers.delete(opts.workspacePath)
        // Task 1: the lock is now free — dequeue+start whatever's next for this workspace, if anything.
        // Must run AFTER the delete above, since start()/startNow() re-checks `controllers.has(wsPath)`.
        this.startNext(opts.workspacePath)
      })
    return controller.state
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
