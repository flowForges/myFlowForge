import { activeSpans, type ActiveSpan } from './perfSpans'
import { SAMPLE_MS, STALL_MS } from './perfConstants'

export type StallHandler = (durationMs: number, active: ActiveSpan[]) => void

export interface MonitorDeps {
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (h: ReturnType<typeof setInterval>) => void
  now: () => number
}

const defaultDeps: MonitorDeps = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h),
  now: () => performance.now(),
}

// A late-firing interval directly measures how long the loop was blocked before it: drift =
// actualGap - expectedGap. Snapshotting active spans immediately after gives the attribution.
export class EventLoopMonitor {
  private handle: ReturnType<typeof setInterval> | null = null
  private last = 0
  constructor(private deps: MonitorDeps = defaultDeps) {}

  start(onStall: StallHandler): void {
    this.last = this.deps.now()
    this.handle = this.deps.setInterval(() => {
      const t = this.deps.now()
      const drift = t - this.last - SAMPLE_MS
      this.last = t
      if (drift >= STALL_MS) {
        try { onStall(Math.round(drift), activeSpans()) } catch { /* never throw */ }
      }
    }, SAMPLE_MS)
    // Don't let this diagnostic sampler keep the process alive on quit (a real timer has .unref();
    // the test-injected fake may not).
    ;(this.handle as { unref?: () => void })?.unref?.()
  }

  stop(): void {
    if (this.handle !== null) { this.deps.clearInterval(this.handle); this.handle = null }
  }
}
