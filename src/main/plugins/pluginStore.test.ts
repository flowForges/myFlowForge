import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InstalledPluginSchema, PluginManifestSchema } from './pluginSchema'
import type { InstalledPlugin } from './pluginSchema'

// ---------- mock parseManifest ----------
const mockParseManifest = vi.fn()
vi.mock('./pluginManifest', () => ({
  parseManifest: (...args: unknown[]) => mockParseManifest(...args),
}))

// ---------- mock paths so pluginsFile() returns a stable string ----------
vi.mock('../config/paths', () => ({
  pluginsFile: () => '/mock/integrations.json',
}))

// ---------- mock store read/write ----------
// We maintain in-memory state that the mock read/write operate on.
const mockState: { plugins: InstalledPlugin[] } = { plugins: [] }
const mockWriteCalls: Array<{ plugins: InstalledPlugin[] }> = []

vi.mock('../config/store', () => ({
  readJson: vi.fn(),
  writeJson: vi.fn(),
}))

// Import AFTER vi.mock declarations
import { readPlugins, installPlugin, uninstallPlugin, setPluginEnabled } from './pluginStore'
import { readJson, writeJson } from '../config/store'

const validManifest = {
  id: 'gh-issues',
  name: 'GitHub Issues',
  type: 'dashboard',
  provider: 'github',
  entry: 'index.js',
  refreshSec: 60,
  version: '1.0.0',
}

beforeEach(() => {
  mockState.plugins = []
  mockWriteCalls.length = 0

  vi.mocked(readJson).mockImplementation((_file, _schema, fallback) => {
    if (mockState.plugins.length === 0) return (fallback as () => unknown)()
    return { plugins: [...mockState.plugins.map((p: InstalledPlugin) => ({ ...p }))] }
  })

  vi.mocked(writeJson).mockImplementation((_file, data) => {
    const d = data as { plugins: InstalledPlugin[] }
    mockState.plugins = d.plugins.map((p: InstalledPlugin) => ({ ...p }))
    mockWriteCalls.push({ plugins: [...mockState.plugins] })
  })

  mockParseManifest.mockReturnValue({ ok: true, manifest: { ...validManifest } })
})

describe('readPlugins', () => {
  it('returns empty array when no plugins stored', () => {
    expect(readPlugins()).toEqual([])
  })

  it('returns stored plugins', () => {
    mockState.plugins = [
      { id: 'gh-issues', dir: '/plugins/gh', type: 'dashboard', name: 'GH', entry: 'index.js', refreshSec: 60, enabled: true },
    ]
    expect(readPlugins()).toHaveLength(1)
  })
})

describe('installPlugin', () => {
  it('appends a new plugin and returns ok:true', () => {
    const result = installPlugin('/plugins/gh-issues')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.plugin.id).toBe('gh-issues')
    expect(result.plugin.enabled).toBe(true)
    expect(mockState.plugins).toHaveLength(1)
    expect(mockState.plugins[0].dir).toBe('/plugins/gh-issues')
  })

  it('upserts when same id already installed (no duplicate, dir updated)', () => {
    mockState.plugins = [
      { id: 'gh-issues', dir: '/old/path', type: 'dashboard', name: 'Old', entry: 'index.js', refreshSec: 300, enabled: false },
    ]
    const result = installPlugin('/plugins/gh-issues-v2')
    expect(result.ok).toBe(true)
    expect(mockState.plugins).toHaveLength(1)
    expect(mockState.plugins[0].dir).toBe('/plugins/gh-issues-v2')
  })

  it('preserves prior enabled=false on duplicate id update', () => {
    mockState.plugins = [
      { id: 'gh-issues', dir: '/old', type: 'dashboard', name: 'Old', entry: 'index.js', refreshSec: 300, enabled: false },
    ]
    const result = installPlugin('/plugins/gh-issues-new')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.plugin.enabled).toBe(false)
    expect(mockState.plugins[0].enabled).toBe(false)
  })

  it('returns ok:false and does NOT write when parseManifest fails', () => {
    mockParseManifest.mockReturnValue({ ok: false, error: '缺少 manifest.json' })
    const result = installPlugin('/bad/dir')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toBe('缺少 manifest.json')
    expect(mockWriteCalls).toHaveLength(0)
  })
})

describe('uninstallPlugin', () => {
  it('removes the plugin with the given id', () => {
    mockState.plugins = [
      { id: 'gh-issues', dir: '/a', type: 'dashboard', name: 'GH', entry: 'index.js', refreshSec: 60, enabled: true },
      { id: 'jira', dir: '/b', type: 'dashboard', name: 'Jira', entry: 'index.js', refreshSec: 120, enabled: true },
    ]
    uninstallPlugin('gh-issues')
    expect(mockState.plugins).toHaveLength(1)
    expect(mockState.plugins[0].id).toBe('jira')
  })

  it('is a no-op when id not found', () => {
    mockState.plugins = [
      { id: 'jira', dir: '/b', type: 'dashboard', name: 'Jira', entry: 'index.js', refreshSec: 120, enabled: true },
    ]
    uninstallPlugin('nonexistent')
    expect(mockState.plugins).toHaveLength(1)
  })
})

describe('setPluginEnabled', () => {
  it('flips enabled to false', () => {
    mockState.plugins = [
      { id: 'gh-issues', dir: '/a', type: 'dashboard', name: 'GH', entry: 'index.js', refreshSec: 60, enabled: true },
    ]
    setPluginEnabled('gh-issues', false)
    expect(mockState.plugins[0].enabled).toBe(false)
  })

  it('flips enabled to true', () => {
    mockState.plugins = [
      { id: 'gh-issues', dir: '/a', type: 'dashboard', name: 'GH', entry: 'index.js', refreshSec: 60, enabled: false },
    ]
    setPluginEnabled('gh-issues', true)
    expect(mockState.plugins[0].enabled).toBe(true)
  })

  it('is a no-op when id not found (still writes)', () => {
    mockState.plugins = []
    setPluginEnabled('nonexistent', true)
    // called writeJson (write empty list)
    expect(mockWriteCalls).toHaveLength(1)
  })
})

describe('native flag', () => {
  it('manifest schema accepts native:true', () => {
    const m = PluginManifestSchema.parse({ id: 'x', name: 'X', type: 'statusbar-usage', entry: 'native', native: true })
    expect(m.native).toBe(true)
  })
  it('installed schema defaults native to undefined/false-ish', () => {
    const p = InstalledPluginSchema.parse({ id: 'x', dir: '/d', type: 'statusbar-usage', name: 'X', entry: 'native', refreshSec: 300 })
    expect(p.native).toBeUndefined()
  })
})
