// Spec §12.7 (run-history): adapts a historical run's persisted `SavedControllerState` (persist.ts —
// the on-disk shape, with a flattened `SavedOutcome[]` per stage) into the same `RunControllerState`
// shape `RunExecPanel`/`runExecAdapter.buildStageRuntimes` expect from a LIVE run (`WorkOrderOutcome[]`,
// nested under `.order`).
//
// This conversion is NOT optional plumbing — `buildStageRuntimes` reads `.order.project`/`.order.provider`/
// `.order.model`/`.order.cwd` directly (see runExecAdapter.ts's buildRootAgent/buildFanoutAgents).
// `SavedOutcome` has no `.order` at all (see persist.ts's save-side flattening), so feeding a
// SavedControllerState's raw `outcomes` straight into `buildStageRuntimes` throws a TypeError the
// moment any stage has a saved outcome. `provider`/`model`/`cwd` ARE persisted per-outcome (see
// persist.ts's SavedOutcome) — this adapter fills `.order` from them when present so a historical
// agent card shows the real values, same as a live run's; only `prompt` (never persisted — it's
// upstream content, not display metadata) and an OLDER saved outcome missing these fields fall
// back to ''. `runExecAdapter`'s own stage-plan fallback (`||`, not `??`) then covers root-scope
// stages/older saves the same way it already does for live-run placeholders.
import type { SavedControllerState } from '../../main/run/persist'
import type { RunControllerState } from '../../main/run/controller'
import type { WorkOrder, WorkOrderOutcome } from '../../main/run/workOrder'

export function toHistoricalState(saved: SavedControllerState): RunControllerState {
  const outcomes: Record<string, WorkOrderOutcome[]> = {}
  for (const [stageKey, list] of Object.entries(saved.outcomes)) {
    outcomes[stageKey] = list.map((o) => {
      const order: WorkOrder = {
        id: o.id, stageKey, name: o.id, project: o.project,
        provider: o.provider ?? '', model: o.model ?? '', cwd: o.cwd ?? '', prompt: '',
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
    laneTimings: saved.laneTimings ?? {},
    paused: false,
    sessionId: saved.sessionId,
    task: saved.task,
    projects: saved.projects,
  }
}
