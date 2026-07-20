// src/main/run/persist.ts
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { wsRunDir, wsRunsDir } from '../config/paths'
import { RunStore } from '../orchestrator/runStore'
import type { RunControllerState } from './controller'

// provider/model/cwd are display-only metadata (used solely by runHistoryAdapter.ts to render a
// historical agent card's provider/model chips and cwd — see runExecAdapter.ts's
// buildRootAgent/buildFanoutAgents) — NEVER upstream content. Resume's own prompt assembly still
// reads ONLY `deps.store.getContext('artifacts:<stageKey>')` (see controller.ts's RehydrateState
// doc / T1's file-vs-slim invariant), so persisting these three fields here does not change what
// a resumed run's downstream stage sees. Optional so an OLDER saved outcome (written before this
// fix) just loads with them absent — a historical card for that older run renders blank exactly
// as it did before, never throws.
export interface SavedOutcome { id: string; status: 'ok' | 'failed'; project?: string; error?: string; attempts: number; provider?: string; model?: string; cwd?: string }
export interface SavedControllerState {
  machine: RunControllerState['machine']
  inbox: RunControllerState['inbox']
  feedback: RunControllerState['feedback']
  status: RunControllerState['status']
  outcomes: Record<string, SavedOutcome[]>
  pendingDirective: RunControllerState['pendingDirective']
  stageTimings: RunControllerState['stageTimings']
  // Improvement ⑥ (see RunControllerState.laneTimings doc, controller.ts). Optional — same
  // backward-compat rationale as sessionId/task/projects below: an OLDER saved run2-state (written
  // before this field existed) loads as `undefined`, and loadControllerState defaults it to `{}`
  // (mirroring stageTimings' own `?? {}` fallback) so a resumed/historical run just shows no
  // per-lane timing rather than throwing on a missing field.
  laneTimings?: RunControllerState['laneTimings']
  // P-C2/T3 (disk-resume review Finding 2): the OWNING session (RunControllerDeps.sessionId, echoed
  // onto state — see controller.ts's `get state()`) and the run's `task` seed (ditto). Neither was
  // previously persisted — a resumed run would silently lose session-card scoping (the P3
  // session-scoping fix reads `run2.state.sessionId`) and its task-seed reinforcement on every stage
  // prompt. Optional so an OLDER saved run2-state (written before this field existed) just loads as
  // `undefined` — resumeFromDisk then falls back to whatever the resume caller supplies (unscoped/no
  // seed), same as before this field existed.
  sessionId?: string
  task?: string
  // P-C2/T3 review Finding 1 (CRITICAL): the EXACT gate-selected project subset this run was
  // launched with (RunControllerDeps.projects — see its doc in controller.ts), persisted so
  // resumeFromDisk can honor the ORIGINAL selection instead of a resume caller's "every project on
  // the workspace" reconstruction. Without this, a still-pending per-project stage resumed after an
  // app restart would fan out against a project the original run never selected — one that was never
  // checked out onto the run's temp branch — and a later finalize-gate merge/discard would then run
  // real git (`add -A`/commit/`clean -fd`) directly against that project's REAL branch, corrupting
  // it. Optional (same rationale as sessionId/task) so an OLDER saved run2-state loads as
  // `undefined`; resumeFromDisk's caller must then fall back to its own reconstruction — see the
  // fallback's risk noted at that call site.
  projects?: RunControllerState['projects']
}

const KEY = 'run2-state'

export function saveControllerState(store: RunStore, s: RunControllerState): void {
  const outcomes: Record<string, SavedOutcome[]> = {}
  for (const [k, list] of Object.entries(s.outcomes)) {
    outcomes[k] = list.map((o) => ({
      id: o.order.id, status: o.status, project: o.order.project, error: o.error, attempts: o.attempts,
      provider: o.order.provider, model: o.order.model, cwd: o.order.cwd,
    }))
  }
  store.setContext(KEY, { machine: s.machine, inbox: s.inbox, feedback: s.feedback, status: s.status, outcomes, pendingDirective: s.pendingDirective, stageTimings: s.stageTimings, laneTimings: s.laneTimings, sessionId: s.sessionId, task: s.task, projects: s.projects })
}
export function loadControllerState(store: RunStore): SavedControllerState | null {
  const got = store.getContext(KEY) as SavedControllerState | undefined
  if (!got) return null
  return { ...got, stageTimings: got.stageTimings ?? {}, laneTimings: got.laneTimings ?? {} }
}

// A run's status only ever reaches 'ok'/'failed' once RunController.start() itself resolves/rejects
// (see controller.ts's terminal assignment right before its final emitUpdate) — 'running'/'awaiting'
// mean the process that was driving it died before it got there. Shared by Run2Manager.resumable()/
// resumeFromDisk() (manager.ts) so both agree on exactly what counts as "still resumable".
export function isTerminalStatus(status: RunControllerState['status']): boolean {
  return status === 'ok' || status === 'failed'
}

// Shared scan primitive for findLatestRun2Run/listRuns below: every run directory under this
// workspace's `.forge/runs/` that actually has a saved run2-state (skips directories from the old
// orchestrator, or a run whose controller never got past construction), paired with its
// context.json's mtime (used by both callers — findLatestRun2Run for "most recent", listRuns for
// "newest first").
function scanRun2Dirs(wsPath: string): Array<{ runId: string; mtimeMs: number; state: SavedControllerState }> {
  const dir = wsRunsDir(wsPath)
  if (!existsSync(dir)) return []
  const out: Array<{ runId: string; mtimeMs: number; state: SavedControllerState }> = []
  for (const entry of readdirSync(dir)) {
    const ctxFile = join(dir, entry, 'context.json')
    if (!existsSync(ctxFile)) continue
    const state = loadControllerState(new RunStore(wsPath, entry))
    if (!state) continue
    const mtimeMs = statSync(ctxFile).mtimeMs
    out.push({ runId: entry, mtimeMs, state })
  }
  return out
}

// P-C2/T2 (disk-resume): a workspace's saved run2-state lives inside a SPECIFIC run's directory
// (`.forge/runs/<runId>/context.json`, keyed by runId — see RunStore/saveControllerState above), but
// after an app restart the manager only knows the WORKSPACE, not which runId was last active. Scans
// every run directory under this workspace's `.forge/runs/` and returns whichever one has the most
// recently modified context.json — i.e. the run that was still in flight when the app died (an
// ended run's file also stops changing once its terminal emitUpdate() writes it, but ties only
// matter across MULTIPLE crashed runs in the same workspace, an edge case not worth resolving more
// precisely than mtime).
export function findLatestRun2Run(wsPath: string): { runId: string; state: SavedControllerState } | null {
  let best: { mtimeMs: number; runId: string; state: SavedControllerState } | null = null
  for (const r of scanRun2Dirs(wsPath)) {
    if (!best || r.mtimeMs > best.mtimeMs) best = r
  }
  return best ? { runId: best.runId, state: best.state } : null
}

// Spec §12.7: run-history list — every past/interrupted run for a workspace, newest first, for a
// read-only "运行历史" review UI (see run2Handlers.ts's run2:list-runs / renderer's
// RunHistoryPanel). Deliberately a thin summary (not the full SavedControllerState — see loadRun
// below for that) so the list itself stays cheap even with many runs. `workflowName` is always
// absent for the same reason ResumableSummary's is (manager.ts) — RunPlan has no name field to
// derive one from.
export interface RunHistoryEntry {
  runId: string
  status: RunControllerState['status']
  doneCount: number
  totalStages: number
  workflowName?: string
  task?: string
  modifiedAt: number
}

export function listRuns(wsPath: string): RunHistoryEntry[] {
  return scanRun2Dirs(wsPath)
    .map(({ runId, mtimeMs, state }) => {
      const stages = state.machine.stages
      return {
        runId,
        status: state.status,
        doneCount: stages.filter((s) => s.status === 'done').length,
        totalStages: stages.length,
        task: state.task,
        modifiedAt: mtimeMs,
      }
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
}

// Spec §12.7: loads one historical run's full saved state for read-only replay (the run-history
// list's "点开进只读运行面板回看" — RunHistoryPanel loads this on row click, then the renderer adapts
// it into a display-only RunControllerState shape — see runHistoryAdapter.ts). Guards on the run
// directory existing first (rather than just delegating straight to `new RunStore` +
// loadControllerState, as findLatestRun2Run's per-entry scan does) so an unknown/typo'd runId
// doesn't spuriously create an empty `.forge/runs/<runId>/artifacts` directory as a side effect of
// RunStore's constructor.
export function loadRun(wsPath: string, runId: string): SavedControllerState | null {
  if (!existsSync(wsRunDir(wsPath, runId))) return null
  return loadControllerState(new RunStore(wsPath, runId))
}

// P-C2/T3: the recovery UI's 丢弃 action — clears the saved run2-state for a workspace's currently
// resumable interrupted run (see Run2Manager.resumable's doc for exactly what counts) so it stops
// being offered again on the next workspace open. Re-validates "is this actually resumable" itself
// (same terminal/none gating findLatestRun2Run + isTerminalStatus already give resumable()) rather
// than trusting a caller's possibly-stale summary — mirrors resumeFromDisk's own re-validation.
// Returns false (no-op, nothing discarded) when there's nothing resumable for this workspace.
export function discardResumableRun(wsPath: string): boolean {
  const found = findLatestRun2Run(wsPath)
  if (!found || isTerminalStatus(found.state.status)) return false
  new RunStore(wsPath, found.runId).deleteContext(KEY)
  return true
}

// Run-state UX fix (run-history delete): clears one EXPLICIT run's saved state so it stops
// appearing in listRuns()'s history — generalizes discardResumableRun above (which only ever
// targets "whichever run is currently resumable") to an arbitrary runId picked from the history
// list, terminal or not. Guards on the run directory existing first, same as loadRun, so deleting
// an unknown/already-deleted runId is a harmless no-op rather than creating an empty directory as
// a RunStore-construction side effect. Callers (run2Handlers.ts's run2:delete-run) are responsible
// for refusing to delete the workspace's currently-LIVE run — this function itself has no notion
// of "live" (that's manager-state, not disk-state) and will happily delete whatever runId it's given.
export function deleteRun(wsPath: string, runId: string): boolean {
  if (!existsSync(wsRunDir(wsPath, runId))) return false
  new RunStore(wsPath, runId).deleteContext(KEY)
  return true
}
