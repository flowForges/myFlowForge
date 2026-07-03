import type { EngineEvent } from '@shared/types'

type Listener = (e: EngineEvent) => void

export class EventBus {
  private listeners = new Set<Listener>()
  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  emit(e: EngineEvent): void { for (const fn of this.listeners) fn(e) }
}
