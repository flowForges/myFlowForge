// src/main/run/persist.ts
import type { RunStore } from '../orchestrator/runStore'
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
}

const KEY = 'run2-state'

export function saveControllerState(store: RunStore, s: RunControllerState): void {
  const outcomes: Record<string, SavedOutcome[]> = {}
  for (const [k, list] of Object.entries(s.outcomes)) {
    outcomes[k] = list.map((o) => ({ id: o.order.id, status: o.status, project: o.order.project, error: o.error, attempts: o.attempts }))
  }
  store.setContext(KEY, { machine: s.machine, inbox: s.inbox, feedback: s.feedback, status: s.status, outcomes, pendingDirective: s.pendingDirective, stageTimings: s.stageTimings })
}
export function loadControllerState(store: RunStore): SavedControllerState | null {
  const got = store.getContext(KEY) as SavedControllerState | undefined
  if (!got) return null
  return { ...got, stageTimings: got.stageTimings ?? {} }
}
