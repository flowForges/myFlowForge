import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '../types'

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
      out.push({ id, label, ...(description ? { description } : {}) })
    }
    return out
  } catch {
    return []
  }
}
