import type { ArtifactRef } from '../orchestrator/types'

export interface AuthEvent { id: string; kind: 'auth'; laneId: string; stageKey: string; title: string; where?: string }
export interface QuestionEvent { id: string; kind: 'question'; laneId: string; stageKey: string; title: string; placeholder?: string }
export interface DoubtEvent { id: string; kind: 'doubt'; laneId: string; stageKey: string; note: string }
export interface FailureEvent { id: string; kind: 'failure'; laneId: string; stageKey: string; error: string; attempts: number }
// `finalize`: P4-3 marker distinguishing the run-completion "收尾确认" gate (合并/丢弃 the run's
// temp branch, see tempBranch.ts) from an ordinary per-stage review gate. Reuses the SAME 'gate'
// kind (and therefore the same resolveGate/gateR/inbox machinery) rather than introducing a new
// RunEvent kind — least churn, since resolveGate already only cares that `e.kind === 'gate'`.
// Renderer (RunEventCard) branches on this flag to show 合并并完成/丢弃本次 instead of the normal
// 通过/打回本阶段/回退到某阶段 actions.
export interface GateEvent { id: string; kind: 'gate'; stageKey: string; body: string; docs?: ArtifactRef[]; finalize?: boolean }

export type RunEvent = AuthEvent | QuestionEvent | DoubtEvent | FailureEvent | GateEvent

export function addEvent(inbox: RunEvent[], e: RunEvent): RunEvent[] {
  return [...inbox, e]
}
export function removeEvent(inbox: RunEvent[], id: string): RunEvent[] {
  return inbox.filter((e) => e.id !== id)
}
export function findEvent(inbox: RunEvent[], id: string): RunEvent | undefined {
  return inbox.find((e) => e.id === id)
}
