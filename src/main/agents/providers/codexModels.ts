import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '../types'

/** codex 的快速档在 models_cache.json / config.toml 里的 id(`service_tier = "priority"`)。 */
export const CODEX_FAST_TIER = 'priority'

export interface CodexModelsDeps { home?: string; readFile?: (p: string) => string }

/**
 * Read the user's REAL locally-available codex models from `~/.codex/models_cache.json`.
 * codex auto-refreshes this file, and it reflects whatever the active provider returned at last
 * fetch (including a GLM-backed provider). This is the dynamic source — no hardcoded model list.
 * Fail-open: returns [] if the file is missing/malformed.
 */
export function readCodexModelsCache(deps: CodexModelsDeps = {}): Model[] {
  const home = deps.home ?? homedir()
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  try {
    const data = JSON.parse(readFile(join(home, '.codex', 'models_cache.json'))) as { models?: unknown }
    const arr = Array.isArray(data.models) ? data.models : []
    const out: Model[] = []
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue
      const o = it as Record<string, unknown>
      const id = typeof o.slug === 'string' ? o.slug : (typeof o.id === 'string' ? o.id : '')
      if (!id) continue
      // Respect codex's visibility flag when present: skip models it doesn't list to users.
      const vis = typeof o.visibility === 'string' ? o.visibility : ''
      if (vis && vis !== 'list') continue
      const label = typeof o.display_name === 'string' && o.display_name ? o.display_name : id
      const description = typeof o.description === 'string' && o.description ? o.description : undefined
      // 快速档:codex 在 `service_tiers` 里列出 `{ id: 'priority', name: 'Fast', description }` 的模型
      // 才能跑 `service_tier="priority"`。没有这个字段 = 不支持(不猜)。
      const priority = Array.isArray(o.service_tiers)
        ? (o.service_tiers as unknown[]).find((t): t is Record<string, unknown> => !!t && typeof t === 'object' && (t as Record<string, unknown>).id === CODEX_FAST_TIER)
        : undefined
      const fastTierDescription = priority && typeof priority.description === 'string' && priority.description ? priority.description : undefined
      out.push({ id, label, ...(description ? { description } : {}), fastTier: !!priority, ...(fastTierDescription ? { fastTierDescription } : {}) })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 这个模型在本机 models_cache 里有没有快速档。chat() 在真的传 `service_tier="priority"` 之前用它兜一层:
 * 会话上的快速开关是存量设置,换到一个没有快速档的模型(或 'default')后不该还带着它跑。
 */
export function codexModelHasFastTier(model: string, deps: CodexModelsDeps = {}): boolean {
  return readCodexModelsCache(deps).some(m => m.id === model && m.fastTier === true)
}
