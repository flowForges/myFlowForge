import { logInfo } from '../log/appLog'
import { MEMORY_LOG_INITIAL_DELAY_MS, MEMORY_LOG_INTERVAL_MS } from './perfConstants'

/** The slice of Electron's `ProcessMetric` this module actually reads. */
export interface MemoryProcessMetric {
  type: string
  memory: { workingSetSize: number } // KB, per app.getAppMetrics()
}

const kbToMB = (kb: number) => Math.round(kb / 1024)
const bytesToMB = (b: number) => Math.round(b / (1024 * 1024))

/**
 * Pure formatter for the periodic `perf` memory line: one entry per OS process (from
 * `app.getAppMetrics()`) naming its type + resident working set (MB), plus the main process's own
 * JS heap (MB). This is the measurement this performance effort's later optimizations get compared
 * against, so the shape of the line must stay stable — hence it's split out and unit-tested on its
 * own rather than inlined into the timer callback.
 */
export function formatMemoryLog(metrics: readonly MemoryProcessMetric[], mainHeapUsedBytes: number): string {
  const perProcess = metrics.map(m => `${m.type} ${kbToMB(m.memory.workingSetSize)}MB`).join(', ')
  return `${perProcess} | main heapUsed ${bytesToMB(mainHeapUsedBytes)}MB`
}

export interface MemoryLogDeps {
  getAppMetrics: () => MemoryProcessMetric[]
  getMainHeapUsedBytes: () => number
  log: (msg: string) => void
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (h: ReturnType<typeof setTimeout>) => void
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (h: ReturnType<typeof setInterval>) => void
}

// Everything except `getAppMetrics`: that one needs Electron's `app.getAppMetrics()`, and this
// module is core logic, not the desktop shell (see coreBoundary.test.ts — only shell files may
// import the Electron package). The caller (src/main/index.ts) supplies it.
export const defaultMemoryLogDeps: Omit<MemoryLogDeps, 'getAppMetrics'> = {
  getMainHeapUsedBytes: () => process.memoryUsage().heapUsed,
  log: (msg) => logInfo('perf', msg),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h),
}

/**
 * Starts the periodic memory baseline log: one line ~60s after startup (so it doesn't add noise to
 * the already-busy boot sequence), then every 10 minutes from `app.getAppMetrics()` is the normal
 * cadence — a before/after diff of these lines is how later optimizations get measured, no DevTools
 * needed. Both timers are unref'd: this is a diagnostic, it must never be the reason the process
 * stays alive on quit. Returns a stop() to call from 'before-quit' alongside the other background
 * services (plugin scheduler, global shortcuts, …).
 */
export function startMemoryLog(deps: MemoryLogDeps): () => void {
  const emit = () => {
    try { deps.log(formatMemoryLog(deps.getAppMetrics(), deps.getMainHeapUsedBytes())) }
    catch { /* a diagnostic must never crash the app */ }
  }
  let interval: ReturnType<typeof setInterval> | null = null
  const initial = deps.setTimeout(() => {
    emit()
    interval = deps.setInterval(emit, MEMORY_LOG_INTERVAL_MS)
    ;(interval as unknown as { unref?: () => void })?.unref?.()
  }, MEMORY_LOG_INITIAL_DELAY_MS)
  ;(initial as unknown as { unref?: () => void })?.unref?.()
  return () => {
    deps.clearTimeout(initial)
    if (interval !== null) deps.clearInterval(interval)
  }
}
