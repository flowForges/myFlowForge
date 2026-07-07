import { logWarn } from '../log/appLog'
import { TOAST_MS, TOAST_DEDUP_MS } from './perfConstants'
import type { ActiveSpan } from './perfSpans'

/** The stall's blame: the longest-running active span, or 'idle' when nothing was wrapped/running. */
export function attributionOf(active: ActiveSpan[]): string {
  if (active.length === 0) return 'idle'
  const top = active.reduce((a, b) => (b.elapsedMs > a.elapsedMs ? b : a))
  return `${top.scope}.${top.label}`
}

export interface StallReporterDeps {
  toast: (msg: string) => void
  now: () => number
}

export class StallReporter {
  private lastToast = new Map<string, number>()
  constructor(private deps: StallReporterDeps) {}

  report(durationMs: number, active: ActiveSpan[]): void {
    const attribution = attributionOf(active)
    const detail = active.map(s => `${s.scope}.${s.label} (${Math.round(s.elapsedMs)}ms)`).join(', ')
    try { logWarn('perf', `stall ${durationMs}ms during ${attribution}`, detail || undefined) } catch { /* never throw */ }
    if (durationMs < TOAST_MS) return
    const t = this.deps.now()
    const prev = this.lastToast.get(attribution)
    if (prev !== undefined && t - prev < TOAST_DEDUP_MS) return
    this.lastToast.set(attribution, t)
    try { this.deps.toast(`主进程卡顿 ${durationMs}ms · ${attribution}`) } catch { /* never throw */ }
  }
}
