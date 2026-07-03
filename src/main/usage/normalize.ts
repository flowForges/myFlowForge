import type { UsageWindow } from './types'

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}

function resetMs(o: Record<string, unknown>, nowMs: number): number | undefined {
  // A reset field can arrive as an epoch number OR an ISO-8601 string under the SAME key —
  // Claude's /oauth/usage returns `resets_at: "2026-06-29T12:20:00.743228+00:00"` (string),
  // while Codex returns `reset_at: 1782740133` (epoch seconds). Inspect each candidate key's
  // value type rather than assuming numeric, so ISO reset times aren't silently dropped.
  const abs = pick(o, ['resetAt', 'reset_at', 'resets_at', 'resetTimeMs', 'resetTime', 'reset_time', 'resets_at_iso'])
  if (typeof abs === 'number' && Number.isFinite(abs)) return abs > 1e12 ? abs : abs * 1000 // <1e12 ⇒ seconds
  if (typeof abs === 'string') {
    const t = Date.parse(abs)
    if (!Number.isNaN(t)) return t
  }
  const rel = num(pick(o, ['resets_in_seconds', 'reset_in_seconds', 'resetInSeconds', 'reset_after_seconds']))
  if (rel !== undefined) return nowMs + rel * 1000
  return undefined
}

// Tolerant: explicit used+limit, else percent-only (limit 100), else remainingFraction (limit 100).
export function normalizeWindow(raw: unknown, nowMs: number): UsageWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const used = num(pick(o, ['used', 'used_units', 'usedUnits']))
  const limit = num(pick(o, ['limit', 'total', 'max']))
  const resetAt = resetMs(o, nowMs)
  if (used !== undefined && limit !== undefined) return { used, limit, ...(resetAt !== undefined ? { resetAt } : {}) }

  const pct = num(pick(o, ['used_percent', 'usedPercent', 'utilization', 'percent_used']))
  if (pct !== undefined) return { used: Math.round(pct), limit: 100, ...(resetAt !== undefined ? { resetAt } : {}) }

  const frac = num(pick(o, ['remainingFraction', 'remaining_fraction']))
  if (frac !== undefined) return { used: Math.round((1 - frac) * 100), limit: 100, ...(resetAt !== undefined ? { resetAt } : {}) }

  return undefined
}
