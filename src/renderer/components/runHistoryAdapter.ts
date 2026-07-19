// Spec §12.7 (run-history): adapts a historical run's persisted `SavedControllerState` (persist.ts —
// the on-disk shape, with a flattened `SavedOutcome[]` per stage) into the same `RunControllerState`
// shape `RunExecPanel`/`runExecAdapter.buildStageRuntimes` expect from a LIVE run (`WorkOrderOutcome[]`,
// nested under `.order`).
//
// This conversion is NOT optional plumbing — `buildStageRuntimes` reads `.order.project`/`.order.provider`/
// `.order.model`/`.order.cwd` directly (see runExecAdapter.ts's buildRootAgent/buildFanoutAgents).
// `SavedOutcome` has no `.order` at all (see persist.ts:42-45's save-side flattening), so feeding a
// SavedControllerState's raw `outcomes` straight into `buildStageRuntimes` throws a TypeError the
// moment any stage has a saved outcome. Only `id`/`status`/`project`/`error`/`attempts` survive the
// save (provider/model/cwd/prompt are never persisted per-outcome) — this adapter fills those four
// with empty strings so the shape is safe to read, not so it displays them; a historical agent card
// therefore never shows provider/model/cwd, which is an accepted limitation of the history view (see
// its doc/report), not a bug.
import type { SavedControllerState } from '../../main/run/persist'
import type { RunControllerState } from '../../main/run/controller'
import type { WorkOrder, WorkOrderOutcome } from '../../main/run/workOrder'

export function toHistoricalState(saved: SavedControllerState): RunControllerState {
  const outcomes: Record<string, WorkOrderOutcome[]> = {}
  for (const [stageKey, list] of Object.entries(saved.outcomes)) {
    outcomes[stageKey] = list.map((o) => {
      const order: WorkOrder = {
        id: o.id, stageKey, name: o.id, project: o.project,
        provider: '', model: '', cwd: '', prompt: '',
      }
      return { order, status: o.status, error: o.error, attempts: o.attempts }
    })
  }
  return {
    machine: saved.machine,
    inbox: saved.inbox,
    feedback: saved.feedback,
    outcomes,
    status: saved.status,
    pendingDirective: saved.pendingDirective,
    // Neither is persisted (see SavedControllerState's doc in persist.ts — both are recomputed by a
    // live controller's start(), never saved): liveLanes has nothing to show for a finished/dead run,
    // and a historical replay is never "paused" (there's no live process to resume).
    liveLanes: {},
    stageTimings: saved.stageTimings,
    paused: false,
    sessionId: saved.sessionId,
    task: saved.task,
    projects: saved.projects,
  }
}
