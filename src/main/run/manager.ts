import type { AgentProvider } from '../agents/types'
import type { DevelopProject } from '../orchestrator/orchestrator'
import type { RunStore } from '../orchestrator/runStore'
import { RunController, type RunControllerState } from './controller'
import type { RunPlan } from './machine'
import type { GateDecision, LaneDecision } from './decisions'
import type { RunEvent } from './events'

export interface Run2Emit {
  event(wsPath: string, e: RunEvent): void
  update(wsPath: string, s: RunControllerState): void
}
export interface Run2StartOpts { workspacePath: string; runId: string; plan: RunPlan; projects: DevelopProject[] }
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
  constructor(private deps: Run2ManagerDeps) {}

  start(opts: Run2StartOpts): RunControllerState {
    if (this.controllers.has(opts.workspacePath)) throw new Error('工作区已有工作流在执行')
    const store = this.deps.makeStore(opts.workspacePath, opts.runId)
    const controller = new RunController(opts.plan, {
      providers: this.deps.providers, store, env: this.deps.env,
      projects: opts.projects, retries: this.deps.retries,
    })
    controller.onEvent((e) => this.deps.emit.event(opts.workspacePath, e))
    controller.onUpdate((s) => this.deps.emit.update(opts.workspacePath, s))
    this.controllers.set(opts.workspacePath, controller)
    // .catch prevents an unhandled rejection (e.g. RunController.start()'s zero-work-orders throw)
    // from crashing the Electron main process; .finally frees the per-workspace serial lock.
    void controller
      .start()
      .catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err))
        this.deps.onError?.(opts.workspacePath, e)
        // ensure the renderer receives a terminal transition even when start() throws before its own
        // terminal emit (e.g. the zero-work-orders guard) — otherwise it's stuck on 'running' forever.
        this.deps.emit.update(opts.workspacePath, { ...controller.state, status: 'failed' })
      })
      .finally(() => { this.controllers.delete(opts.workspacePath) })
    return controller.state
  }
  get(wsPath: string): RunController | undefined { return this.controllers.get(wsPath) }
  isActive(wsPath: string): boolean { return this.controllers.has(wsPath) }
  resolveGate(wsPath: string, eventId: string, d: GateDecision): boolean { return this.controllers.get(wsPath)?.resolveGate(eventId, d) ?? false }
  resolveLane(wsPath: string, eventId: string, d: LaneDecision): boolean { return this.controllers.get(wsPath)?.resolveLane(eventId, d) ?? false }
  addFeedback(wsPath: string, text: string): void { this.controllers.get(wsPath)?.addFeedback(text) }
  editFeedback(wsPath: string, id: string, text: string): void { this.controllers.get(wsPath)?.editFeedback(id, text) }
  removeFeedback(wsPath: string, id: string): void { this.controllers.get(wsPath)?.removeFeedback(id) }
  abort(wsPath: string): void { this.controllers.get(wsPath)?.abort() }
}
