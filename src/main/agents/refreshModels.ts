import type { AgentProvider, Model } from './types'
import { readAgentsConfig, writeAgentsConfig } from '../config/store'

/**
 * Persist a user-supplied model list for a provider (overwrites modelsCache).
 * - Non-empty list: writes cache + updates modelsFetchedAt to nowMs.
 * - Empty list: clears cache (modelsFetchedAt = 0) → detect falls back to static catalog.
 * `nowMs` is injected for deterministic tests.
 */
// Union two model lists by id, preserving order: `primary` first, then any `extra` not already present.
function unionById(primary: Model[], extra: Model[]): Model[] {
  const seen = new Set(primary.map(m => m.id))
  return [...primary, ...extra.filter(m => !seen.has(m.id))]
}

export function setProviderModels(providerId: string, models: Model[], nowMs: number = Date.now()): Model[] {
  const cfg = readAgentsConfig()
  const existing = cfg.providers.find(c => c.id === providerId)
  if (existing) {
    existing.modelsCache = models
    existing.modelsFetchedAt = models.length ? nowMs : 0
    // Remember these as USER-PINNED so a later live refresh unions them back in instead of dropping the
    // user's custom model (e.g. a qoder 自定义模型 that never shows up in `--list-models`). Empty = clear.
    existing.customModels = models
  } else {
    cfg.providers.push({ id: providerId, binOverride: '', env: {}, modelsCache: models, modelsFetchedAt: models.length ? nowMs : 0, customModels: models })
  }
  writeAgentsConfig(cfg)
  return models
}

/**
 * Refresh cached models for a provider that supports `listModelsLive`.
 * - If live results are non-empty: updates agents.json modelsCache + modelsFetchedAt and returns them.
 * - If live returns empty (or throws): preserves existing cache, returns it with an error string.
 * - If the provider doesn't have listModelsLive: returns empty models with an error string.
 *
 * `nowMs` is injected (defaults to Date.now()) to keep tests deterministic.
 */
export async function refreshProviderModels(
  providerId: string,
  providers: Record<string, AgentProvider>,
  env: NodeJS.ProcessEnv,
  nowMs: number = Date.now(),
): Promise<{ models: Model[]; error?: string }> {
  const p = providers[providerId]
  if (!p?.listModelsLive) {
    return { models: [], error: '该 provider 不支持动态模型' }
  }

  let live: Model[] = []
  try {
    live = await p.listModelsLive(env)
  } catch {
    // treat thrown errors the same as an empty result
    live = []
  }

  const cfg = readAgentsConfig()

  if (live.length > 0) {
    // Upsert the provider config entry with new cache, but UNION user-pinned custom models on top so a
    // live `--list-models` (which never returns a user's 自定义模型) can't silently drop it.
    const existing = cfg.providers.find(c => c.id === providerId)
    const pinned = existing?.customModels ?? []
    const merged = unionById(live, pinned)
    if (existing) {
      existing.modelsCache = merged
      existing.modelsFetchedAt = nowMs
    } else {
      cfg.providers.push({ id: providerId, binOverride: '', env: {}, modelsCache: merged, modelsFetchedAt: nowMs })
    }
    writeAgentsConfig(cfg)
    return { models: merged }
  } else {
    // Keep existing cache, do NOT overwrite with empty
    const existing = cfg.providers.find(c => c.id === providerId)
    const oldCache = existing?.modelsCache ?? []
    return { models: oldCache, error: '刷新失败(空结果)' }
  }
}
