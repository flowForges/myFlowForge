// Hardcoded thresholds for the perf monitor (v1 — no settings toggle, YAGNI).
export const STALL_MS = 100        // log a stall at/above this event-loop drift
export const TOAST_MS = 500        // popup a stall at/above this
export const OP_LOG_MS = 50        // log an operation's duration at/above this
export const SAMPLE_MS = 50        // drift sampler interval
export const TOAST_DEDUP_MS = 30_000 // per-attribution popup throttle
