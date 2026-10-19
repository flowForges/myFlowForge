// Hardcoded thresholds for the perf monitor (v1 — no settings toggle, YAGNI).
export const STALL_MS = 100        // log a stall at/above this event-loop drift
export const TOAST_MS = 500        // popup a stall at/above this
export const OP_LOG_MS = 50        // log an operation's duration at/above this
export const SAMPLE_MS = 50        // drift sampler interval
export const TOAST_DEDUP_MS = 30_000 // per-attribution popup throttle

// Memory baseline log (see memoryLog.ts): first line shortly after boot, then on a steady cadence.
export const MEMORY_LOG_INITIAL_DELAY_MS = 60_000     // first `perf` memory line, ~60s after startup
export const MEMORY_LOG_INTERVAL_MS = 10 * 60_000     // then every 10 minutes
