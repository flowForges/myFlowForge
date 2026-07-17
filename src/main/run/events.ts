import type { ArtifactRef } from '../orchestrator/types'

export interface AuthEvent { id: string; kind: 'auth'; laneId: string; stageKey: string; title: string; where?: string }
export interface QuestionEvent { id: string; kind: 'question'; laneId: string; stageKey: string; title: string; placeholder?: string }
export interface DoubtEvent { id: string; kind: 'doubt'; laneId: string; stageKey: string; note: string }
export interface FailureEvent { id: string; kind: 'failure'; laneId: string; stageKey: string; error: string; attempts: number }
export interface GateEvent { id: string; kind: 'gate'; stageKey: string; body: string; docs?: ArtifactRef[] }

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
