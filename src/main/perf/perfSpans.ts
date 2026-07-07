import { logDebug } from '../log/appLog'
import { OP_LOG_MS } from './perfConstants'

export interface ActiveSpan { scope: string; label: string; elapsedMs: number }

let nextId = 1
const spans = new Map<number, { scope: string; label: string; start: number }>()
let now: () => number = () => performance.now()

/** Test seam: override the clock. */
export function __setPerfNow(fn: () => number): void { now = fn }

export function activeCount(): number { return spans.size }

/** Snapshot of currently-running spans with how long each has been in-flight. */
export function activeSpans(): ActiveSpan[] {
  const t = now()
  return [...spans.values()].map(s => ({ scope: s.scope, label: s.label, elapsedMs: t - s.start }))
}

/**
 * Wrap a hot operation so it appears in the active-span set while it runs (for stall attribution) and
 * its duration is logged when it finishes. Transparent: returns exactly fn's value/rejection.
 * Never throws from its own bookkeeping.
 */
export function perfSpan<T>(scope: string, label: string, fn: () => T): T {
  const id = nextId++
  const start = now()
  spans.set(id, { scope, label, start })
  const end = () => {
    spans.delete(id)
    const dur = now() - start
    if (dur >= OP_LOG_MS) {
      try { logDebug('perf', `${scope}.${label} ${Math.round(dur)}ms`) } catch { /* never throw */ }
    }
  }
  let result: T
  try {
    result = fn()
  } catch (e) {
    end()
    throw e
  }
  if (result != null && typeof (result as { then?: unknown }).then === 'function') {
    return (result as unknown as Promise<unknown>).finally(end) as unknown as T
  }
  end()
  return result
}
