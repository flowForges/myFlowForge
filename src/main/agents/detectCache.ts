import { detectProviders, type DetectOptions } from './detect'
import type { AgentProvider } from './types'
import type { ProviderInfo } from '@shared/types'

/**
 * Process-wide memory cache around detectProviders().
 *
 * Detection spawns real CLI subprocesses (claude/codex are slow node wrappers), and it is
 * called from several independent places (App startup useConfig, InstallBanner, the settings
 * AgentsPane mount, the 重新检测 button). Without a cache each caller pays the full probe cost
 * and concurrent callers multiply it. Here:
 *  - concurrent callers share the single in-flight promise (dedup)
 *  - a completed result is served for DETECT_CACHE_TTL_MS (App startup warms the cache, so
 *    opening settings shortly after is instant)
 *  - `force: true` (重新检测 / registry rebuilds) bypasses and refills the cache
 *  - failures are never cached
 */
export const DETECT_CACHE_TTL_MS = 60_000

interface CacheState {
  promise: Promise<ProviderInfo[]> | null
  /** Epoch ms when the promise resolved; 0 while still in flight. */
  resolvedAt: number
}

let state: CacheState = { promise: null, resolvedAt: 0 }

export interface CachedDetectOptions extends DetectOptions {
  /** Skip (and refill) the cache — used by the 重新检测 button and after registry rebuilds. */
  force?: boolean
  ttlMs?: number
}

export function invalidateDetectCache(): void {
  state = { promise: null, resolvedAt: 0 }
}

export function cachedDetectProviders(
  registry: Record<string, AgentProvider>,
  env: NodeJS.ProcessEnv,
  opts: CachedDetectOptions = {},
): Promise<ProviderInfo[]> {
  const { force, ttlMs = DETECT_CACHE_TTL_MS, ...detectOpts } = opts
  const now = opts.nowMs ?? Date.now()

  if (!force && state.promise) {
    const inFlight = state.resolvedAt === 0
    if (inFlight || now - state.resolvedAt < ttlMs) return state.promise
  }

  const probe: Promise<ProviderInfo[]> = detectProviders(registry, env, detectOpts).then(
    (res) => {
      if (state.promise === probe) state.resolvedAt = opts.nowMs ?? Date.now()
      return res
    },
    (err) => {
      // Never cache failures — drop so the next caller retries.
      if (state.promise === probe) state = { promise: null, resolvedAt: 0 }
      throw err
    },
  )
  state = { promise: probe, resolvedAt: 0 }
  return probe
}
