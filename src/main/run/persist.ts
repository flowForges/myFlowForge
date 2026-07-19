// src/main/run/persist.ts
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { wsRunsDir } from '../config/paths'
import { RunStore } from '../orchestrator/runStore'
import type { RunControllerState } from './controller'

export interface SavedOutcome { id: string; status: 'ok' | 'failed'; project?: string; error?: string; attempts: number }
export interface SavedControllerState {
  machine: RunControllerState['machine']
  inbox: RunControllerState['inbox']
  feedback: RunControllerState['feedback']
  status: RunControllerState['status']
  outcomes: Record<string, SavedOutcome[]>
  pendingDirective: RunControllerState['pendingDirective']
  stageTimings: RunControllerState['stageTimings']
  // P-C2/T3 (disk-resume review Finding 2): the OWNING session (RunControllerDeps.sessionId, echoed
  // onto state — see controller.ts's `get state()`) and the run's `task` seed (ditto). Neither was
  // previously persisted — a resumed run would silently lose session-card scoping (the P3
  // session-scoping fix reads `run2.state.sessionId`) and its task-seed reinforcement on every stage
  // prompt. Optional so an OLDER saved run2-state (written before this field existed) just loads as
  // `undefined` — resumeFromDisk then falls back to whatever the resume caller supplies (unscoped/no
  // seed), same as before this field existed.
  sessionId?: string
  task?: string
}

const KEY = 'run2-state'

export function saveControllerState(store: RunStore, s: RunControllerState): void {
  const outcomes: Record<string, SavedOutcome[]> = {}
  for (const [k, list] of Object.entries(s.outcomes)) {
    outcomes[k] = list.map((o) => ({ id: o.order.id, status: o.status, project: o.order.project, error: o.error, attempts: o.attempts }))
  }
  store.setContext(KEY, { machine: s.machine, inbox: s.inbox, feedback: s.feedback, status: s.status, outcomes, pendingDirective: s.pendingDirective, stageTimings: s.stageTimings, sessionId: s.sessionId, task: s.task })
}
export function loadControllerState(store: RunStore): SavedControllerState | null {
  const got = store.getContext(KEY) as SavedControllerState | undefined
  if (!got) return null
  return { ...got, stageTimings: got.stageTimings ?? {} }
}

// A run's status only ever reaches 'ok'/'failed' once RunController.start() itself resolves/rejects
// (see controller.ts's terminal assignment right before its final emitUpdate) — 'running'/'awaiting'
// mean the process that was driving it died before it got there. Shared by Run2Manager.resumable()/
// resumeFromDisk() (manager.ts) so both agree on exactly what counts as "still resumable".
export function isTerminalStatus(status: RunControllerState['status']): boolean {
  return status === 'ok' || status === 'failed'
}

// P-C2/T2 (disk-resume): a workspace's saved run2-state lives inside a SPECIFIC run's directory
// (`.forge/runs/<runId>/context.json`, keyed by runId — see RunStore/saveControllerState above), but
// after an app restart the manager only knows the WORKSPACE, not which runId was last active. Scans
// every run directory under this workspace's `.forge/runs/` and returns whichever one BOTH (a)
// actually has a saved run2-state (skips directories from the old orchestrator, or a run whose
// controller never got past construction) and (b) has the most recently modified context.json —
// i.e. the run that was still in flight when the app died (an ended run's file also stops changing
// once its terminal emitUpdate() writes it, but ties only matter across MULTIPLE crashed runs in the
// same workspace, an edge case not worth resolving more precisely than mtime).
export function findLatestRun2Run(wsPath: string): { runId: string; state: SavedControllerState } | null {
  const dir = wsRunsDir(wsPath)
  if (!existsSync(dir)) return null
  let best: { mtimeMs: number; runId: string; state: SavedControllerState } | null = null
  for (const entry of readdirSync(dir)) {
    const ctxFile = join(dir, entry, 'context.json')
    if (!existsSync(ctxFile)) continue
    const state = loadControllerState(new RunStore(wsPath, entry))
    if (!state) continue
    const mtimeMs = statSync(ctxFile).mtimeMs
    if (!best || mtimeMs > best.mtimeMs) best = { mtimeMs, runId: entry, state }
  }
  return best ? { runId: best.runId, state: best.state } : null
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
