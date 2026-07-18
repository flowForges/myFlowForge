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
}
export interface Run2StartOpts { workspacePath: string; runId: string; plan: RunPlan; projects: DevelopProject[]; task?: string; permissionMode?: PermissionMode }
export interface Run2ManagerDeps {
  providers: Record<string, AgentProvider>
  env: NodeJS.ProcessEnv
  makeStore: (wsPath: string, runId: string) => RunStore
  emit: Run2Emit
  retries?: number
  onError?: (wsPath: string, err: Error) => void
}

export class Run2Manager {
  private controllers = new Map<string, RunController>()
  // Additive: retains the terminal state of the most recently *completed* run per workspace, so the
  // renderer's run2:get-state can still show a finished run's outcomes/status after the controller is
  // removed from `controllers` (which frees the serial lock but would otherwise lose the final state).
  private lastState = new Map<string, RunControllerState>()
  constructor(private deps: Run2ManagerDeps) {}

  start(opts: Run2StartOpts): RunControllerState {
    if (this.controllers.has(opts.workspacePath)) throw new Error('工作区已有工作流在执行')
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
}
