import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildProviderRegistry, rebuildProviderRegistry } from './registry'
import { BUILTIN_PROVIDERS } from '@shared/providerCatalog'
import type { AgentsConfig } from '../config/schema'

let agentsConfig: AgentsConfig
vi.mock('../config/store', () => ({ readAgentsConfig: () => agentsConfig }))

beforeEach(() => { agentsConfig = { providers: [], custom: [] } })

describe('provider registry', () => {
  it('registers claude, codex, gemini, qoder and cursor built-ins keyed by their ids', () => {
    const reg = buildProviderRegistry()
    expect(reg['claude'].displayName).toBe('Claude Code')
    expect(reg['codex'].displayName).toBe('Codex')
    expect(reg['gemini'].displayName).toBe('Gemini CLI')
    expect(reg['qoder'].displayName).toBe('Qoder')
    expect(reg['cursor'].displayName).toBe('Cursor Agent')
    expect(Object.keys(reg)).toHaveLength(5)
  })

  it('includes user-added custom agents alongside the built-ins', () => {
    agentsConfig = { providers: [], custom: [{ id: 'mycli', displayName: 'My CLI', bin: '/opt/mycli', argsTemplate: 'chat {prompt}', models: [] }] }
    const reg = buildProviderRegistry()
    expect(reg['mycli']).toBeDefined()
    expect(reg['mycli'].displayName).toBe('My CLI')
    expect(Object.keys(reg)).toHaveLength(6)
  })

  it('each builtin listModels() returns the catalog defaultModels (except dynamic codex)', async () => {
    const reg = buildProviderRegistry()
    for (const meta of BUILTIN_PROVIDERS) {
      const models = await reg[meta.id].listModels(process.env)
      // codex reads the user's REAL local models from ~/.codex/models_cache.json, so its list is
      // machine-dependent — it only falls back to the catalog defaults when no cache exists.
      if (meta.id === 'codex') { expect(models.length).toBeGreaterThanOrEqual(1); continue }
      expect(models).toEqual(meta.defaultModels)
    }
  })

  it('rebuildProviderRegistry mutates the same object reference in place', () => {
    const reg = buildProviderRegistry()
    expect(reg['mycli']).toBeUndefined()
    agentsConfig = { providers: [], custom: [{ id: 'mycli', displayName: 'My CLI', bin: '/opt/mycli', argsTemplate: '{prompt}', models: [] }] }
    const same = rebuildProviderRegistry(reg)
    expect(same).toBe(reg)              // same reference
    expect(reg['mycli']).toBeDefined()  // now contains the custom agent
  })
})
