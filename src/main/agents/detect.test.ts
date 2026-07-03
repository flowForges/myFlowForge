import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { detectProviders } from './detect'
import { BUILTIN_IDS } from '@shared/providerCatalog'
import type { AgentProvider, AgentTask, AgentCallbacks } from './types'

// Mock the store so we control agents.json reads
vi.mock('../config/store', () => ({
  readAgentsConfig: vi.fn(),
  writeAgentsConfig: vi.fn(),
}))

import { readAgentsConfig } from '../config/store'
const mockedReadAgentsConfig = vi.mocked(readAgentsConfig)

function fake(id: string, name: string, installed: boolean, liveModels?: boolean): AgentProvider {
  return {
    id, displayName: name,
    capabilities: { structuredOutput: true, permissionHook: true, pty: false, liveModels },
    async detect() { return installed },
    async listModels() { return [{ id: 'm1', label: 'M1' }] },
    run(_task: AgentTask, _cb: AgentCallbacks, _env: NodeJS.ProcessEnv) {
      return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no agents.json config
  mockedReadAgentsConfig.mockReturnValue({ providers: [], custom: [] })
})

describe('BUILTIN_IDS from catalog', () => {
  it('contains exactly the 5 builtin provider ids', () => {
    expect(BUILTIN_IDS).toEqual(['claude', 'codex', 'gemini', 'qoder', 'cursor'])
  })
})

describe('detectProviders', () => {
  it('reports installed + models per provider, models only when installed', async () => {
    const reg = { a: fake('a', 'Alpha', true), b: fake('b', 'Beta', false) }
    const infos = await detectProviders(reg, process.env)
    const a = infos.find(i => i.id === 'a')!; const b = infos.find(i => i.id === 'b')!
    expect(a.installed).toBe(true); expect(a.models).toHaveLength(1)
    expect(b.installed).toBe(false); expect(b.models).toHaveLength(0)
  })

  it('treats a hanging detect() as not installed (timeout)', async () => {
    const hang: AgentProvider = {
      id: 'slow', displayName: 'Slow', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: () => new Promise<boolean>(() => {}),   // never resolves
      listModels: async () => [], run: () => ({ id: 'x', cancel: () => {}, done: Promise.resolve({ ok: true }) }),
    }
    const out = await detectProviders({ slow: hang }, process.env, 50)
    expect(out).toEqual([{ id: 'slow', displayName: 'Slow', installed: false, models: [], bin: '', binPath: '', custom: true }])
  })

  it('reports an absolute bin path as-is and flags built-in vs custom', async () => {
    const claude: AgentProvider = {
      id: 'claude', displayName: 'Claude Code', bin: '/opt/bin/claude',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [], run: () => ({ id: 'x', cancel: () => {}, done: Promise.resolve({ ok: true }) }),
    }
    const out = await detectProviders({ claude }, process.env)
    expect(out[0].binPath).toBe('/opt/bin/claude')
    expect(out[0].bin).toBe('/opt/bin/claude')
    expect(out[0].custom).toBe(false)
  })

  it('uses the real detect result when it resolves before the timeout', async () => {
    const ok: AgentProvider = {
      id: 'fast', displayName: 'Fast', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [{ id: 'm', label: 'm' }],
      run: () => ({ id: 'x', cancel: () => {}, done: Promise.resolve({ ok: true }) }),
    }
    const out = await detectProviders({ fast: ok }, process.env, 1000)
    expect(out[0]).toEqual({ id: 'fast', displayName: 'Fast', installed: true, models: [{ id: 'm', label: 'm' }], bin: '', binPath: '', custom: true })
  })
})

describe('detectProviders — cache priority', () => {
  it('uses modelsCache from agents.json when non-empty (ignores listModels)', async () => {
    const cached = [{ id: 'cached-m', label: 'Cached Model' }]
    mockedReadAgentsConfig.mockReturnValue({
      providers: [{ id: 'qoder', binOverride: '', env: {}, modelsCache: cached, modelsFetchedAt: Date.now() }],
      custom: [],
    })

    const listModelsSpy = vi.fn(async () => [{ id: 'live-m', label: 'Live' }])
    const p: AgentProvider = {
      id: 'qoder', displayName: 'Qoder',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: false },
      detect: async () => true,
      listModels: listModelsSpy,
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }

    const out = await detectProviders({ qoder: p }, process.env)
    expect(out[0].models).toEqual(cached)
    expect(listModelsSpy).not.toHaveBeenCalled()
  })

  it('falls back to catalog listModels when cache is empty', async () => {
    mockedReadAgentsConfig.mockReturnValue({
      providers: [{ id: 'qoder', binOverride: '', env: {}, modelsCache: [], modelsFetchedAt: 0 }],
      custom: [],
    })

    const catalogModels = [{ id: 'catalog-m', label: 'Catalog' }]
    const p: AgentProvider = {
      id: 'qoder', displayName: 'Qoder',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: false },
      detect: async () => true,
      listModels: async () => catalogModels,
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }

    const out = await detectProviders({ qoder: p }, process.env)
    expect(out[0].models).toEqual(catalogModels)
  })

  it('falls back to listModels when provider has no entry in agents.json', async () => {
    // default mock: no providers
    const catalogModels = [{ id: 'def', label: 'Default' }]
    const p: AgentProvider = {
      id: 'cursor', displayName: 'Cursor',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true,
      listModels: async () => catalogModels,
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }

    const out = await detectProviders({ cursor: p }, process.env)
    expect(out[0].models).toEqual(catalogModels)
  })
})

describe('detectProviders — ProviderInfo.liveModels', () => {
  it('includes liveModels:true for providers with liveModels capability', async () => {
    const p = fake('qoder', 'Qoder', true, true)
    const out = await detectProviders({ qoder: p }, process.env)
    expect(out[0].liveModels).toBe(true)
  })

  it('includes liveModels:false for providers without liveModels capability (e.g. claude)', async () => {
    const p = fake('claude', 'Claude Code', true, false)
    const out = await detectProviders({ claude: p }, process.env)
    expect(out[0].liveModels).toBe(false)
  })

  it('liveModels is falsy for providers where capability is undefined', async () => {
    const p: import('./types').AgentProvider = {
      id: 'other', displayName: 'Other',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true,
      listModels: async () => [],
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }
    const out = await detectProviders({ other: p }, process.env)
    expect(out[0].liveModels).toBeFalsy()
  })
})

describe('detectProviders install guidance', () => {
  it('stamps install/auth/help for built-in providers', async () => {
    const reg = { claude: fake('claude', 'Claude Code', false) }
    const [info] = await detectProviders(reg, process.env, { timeoutMs: 50 })
    expect(info.installCmd).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(info.authCmd).toBe('claude')
    expect(info.installHelp).not.toBe('')
  })
  it('leaves custom providers without guidance', async () => {
    const reg = { 'my-agent': fake('my-agent', 'My Agent', true) }
    const [info] = await detectProviders(reg, process.env, { timeoutMs: 50 })
    expect(info.installCmd).toBeUndefined()
  })
})

describe('detectProviders — single --version spawn per bin', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'detect-probe-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // A fake CLI that records every invocation to a counter file and prints a version.
  function fakeBin(): { bin: string; countFile: string } {
    const countFile = join(dir, 'count.txt')
    const bin = join(dir, 'fakecli.js')
    writeFileSync(bin, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(countFile)}, process.argv.slice(2).join(' ') + '\\n')
process.stdout.write('fakecli 9.8.7\\n')
`)
    chmodSync(bin, 0o755)
    return { bin, countFile }
  }
  const invocations = (countFile: string): string[] =>
    existsSync(countFile) ? readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean) : []

  it('spawns <bin> --version exactly once for an installed provider (detect + version merged)', async () => {
    const { bin, countFile } = fakeBin()
    // Mirrors the real providers: detect() itself would run `<bin> --version`
    const p: AgentProvider = {
      id: 'fake', displayName: 'Fake', bin,
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { try { await execa(bin, ['--version']); return true } catch { return false } },
      listModels: async () => [],
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }
    // Generous timeout: node-script spawns can take seconds on a loaded CI machine
    const out = await detectProviders({ fake: p }, process.env, { timeoutMs: 30_000 })
    expect(out[0].installed).toBe(true)
    expect(out[0].version).toBe('9.8.7')
    expect(invocations(countFile)).toEqual(['--version'])   // exactly one spawn
  }, 40_000)

  it('falls back to p.detect() when the probe fails but detect() succeeds (custom detection logic)', async () => {
    const p: AgentProvider = {
      id: 'weird', displayName: 'Weird', bin: '/nonexistent/weird-cli',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true,   // provider says installed even though probe fails
      listModels: async () => [{ id: 'm', label: 'M' }],
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }
    const out = await detectProviders({ weird: p }, process.env)
    expect(out[0].installed).toBe(true)
    expect(out[0].version).toBeUndefined()   // no version obtainable
  })
})

describe('detectProviders — background refresh scheduling', () => {
  it('schedules background refresh when liveModels=true and cache is empty', async () => {
    const refreshSpy = vi.fn()
    const p: AgentProvider = {
      id: 'qoder', displayName: 'Qoder',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: true },
      detect: async () => true,
      listModels: async () => [{ id: 'm', label: 'M' }],
      listModelsLive: async () => [{ id: 'live', label: 'Live' }],
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }

    await detectProviders({ qoder: p }, process.env, { scheduleRefresh: refreshSpy })
    expect(refreshSpy).toHaveBeenCalledOnce()
    expect(refreshSpy.mock.calls[0][0]).toBe('qoder')
  })

  it('schedules background refresh when liveModels=true and cache is stale (>7d)', async () => {
    const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000
    const staleTimestamp = Date.now() - SEVEN_DAYS_MS - 1000
    mockedReadAgentsConfig.mockReturnValue({
      providers: [{ id: 'qoder', binOverride: '', env: {}, modelsCache: [{ id: 'old', label: 'Old' }], modelsFetchedAt: staleTimestamp }],
      custom: [],
    })

    const refreshSpy = vi.fn()
    const p: AgentProvider = {
      id: 'qoder', displayName: 'Qoder',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: true },
      detect: async () => true,
      listModels: async () => [],
      listModelsLive: async () => [{ id: 'live', label: 'Live' }],
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }

    await detectProviders({ qoder: p }, process.env, { scheduleRefresh: refreshSpy })
    expect(refreshSpy).toHaveBeenCalledOnce()
  })

  it('does NOT schedule refresh when cache is fresh (within 7d)', async () => {
    const freshTimestamp = Date.now() - 1000   // 1 second ago
    mockedReadAgentsConfig.mockReturnValue({
      providers: [{ id: 'qoder', binOverride: '', env: {}, modelsCache: [{ id: 'fresh', label: 'Fresh' }], modelsFetchedAt: freshTimestamp }],
      custom: [],
    })

    const refreshSpy = vi.fn()
    const p: AgentProvider = {
      id: 'qoder', displayName: 'Qoder',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: true },
      detect: async () => true,
      listModels: async () => [],
      listModelsLive: async () => [{ id: 'live', label: 'Live' }],
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }

    await detectProviders({ qoder: p }, process.env, { scheduleRefresh: refreshSpy })
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('does NOT schedule refresh when liveModels capability is false', async () => {
    const refreshSpy = vi.fn()
    const p: AgentProvider = {
      id: 'claude', displayName: 'Claude',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: false },
      detect: async () => true,
      listModels: async () => [{ id: 'm', label: 'M' }],
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }

    await detectProviders({ claude: p }, process.env, { scheduleRefresh: refreshSpy })
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('detect returns promptly without awaiting live refresh', async () => {
    // scheduleRefresh is synchronously called but detect doesn't await it
    let resolveRefresh!: () => void
    const slowRefresh = vi.fn(() => {
      new Promise<void>(r => { resolveRefresh = r })   // never resolves unless we call resolveRefresh
    })

    const p: AgentProvider = {
      id: 'qoder', displayName: 'Qoder',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false, liveModels: true },
      detect: async () => true,
      listModels: async () => [{ id: 'm', label: 'M' }],
      listModelsLive: async () => [{ id: 'live', label: 'Live' }],
      run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    }

    // Should resolve immediately even though the scheduled "refresh" never resolves
    const start = Date.now()
    await detectProviders({ qoder: p }, process.env, { scheduleRefresh: slowRefresh })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
    expect(slowRefresh).toHaveBeenCalledOnce()
  })
})
