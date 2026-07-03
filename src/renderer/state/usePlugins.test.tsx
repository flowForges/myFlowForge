import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePlugins } from './usePlugins'
import type { InstalledPlugin, PluginResult, PluginSnapshot } from '@shared/plugins'

// ─── Mock data ─────────────────────────────────────────────────────────────

const pluginA: InstalledPlugin = {
  id: 'plugin-a',
  dir: '/plugins/a',
  type: 'statusbar-usage',
  provider: 'claude',
  name: 'Claude Usage',
  entry: 'index.js',
  refreshSec: 60,
  enabled: true,
}

const pluginB: InstalledPlugin = {
  id: 'plugin-b',
  dir: '/plugins/b',
  type: 'statusbar-usage',
  provider: 'codex',
  name: 'Codex Usage',
  entry: 'index.js',
  refreshSec: 60,
  enabled: true,
}

const pluginC: InstalledPlugin = {
  id: 'plugin-c',
  dir: '/plugins/c',
  type: 'other',            // not statusbar-usage
  provider: 'other-provider',
  name: 'Other Plugin',
  entry: 'index.js',
  refreshSec: 60,
  enabled: true,
}

const pluginD: InstalledPlugin = {
  id: 'plugin-d',
  dir: '/plugins/d',
  type: 'statusbar-usage',
  provider: undefined,      // no provider
  name: 'No Provider',
  entry: 'index.js',
  refreshSec: 60,
  enabled: true,
}

const resultA: PluginResult = {
  ok: true,
  type: 'statusbar-usage',
  data: { window5h: { used: 10, limit: 100, resetAt: 9999 }, label: 'Claude' },
  at: 1000,
}

const resultB: PluginResult = {
  ok: true,
  type: 'statusbar-usage',
  data: { weekly: { used: 5, limit: 50 } },
  at: 1001,
}

const resultC: PluginResult = {
  ok: true,
  type: 'other',
  data: { foo: 'bar' },
  at: 1002,
}

const resultFail: PluginResult = {
  ok: false,
  error: 'timeout',
  at: 1003,
}

const initialSnapshot: PluginSnapshot = {
  plugins: [pluginA],
  results: { 'plugin-a': resultA },
}

// ─── Setup ─────────────────────────────────────────────────────────────────

let pluginsChangedCb: ((snap: PluginSnapshot) => void) | null = null
let unsubCalled = false

const exampleCatalog = [
  {
    id: 'forge-example-claude-usage',
    name: 'Claude 额度（示例）',
    description: 'd',
    icon: 'gauge',
    type: 'statusbar-usage',
    provider: 'claude',
    installed: false,
    available: true,
  },
]

beforeEach(() => {
  pluginsChangedCb = null
  unsubCalled = false
  ;(window as any).forge = {
    listPlugins: vi.fn(async () => initialSnapshot),
    installPlugin: vi.fn(async (_dir: string) => ({ ok: true })),
    uninstallPlugin: vi.fn(async () => {}),
    setPluginEnabled: vi.fn(async () => {}),
    refreshPlugins: vi.fn(async () => {}),
    pickDirectory: vi.fn(async () => '/some/dir'),
    onPluginsChanged: vi.fn((cb: (snap: PluginSnapshot) => void) => {
      pluginsChangedCb = cb
      return () => { unsubCalled = true }
    }),
    listPluginCatalog: vi.fn(async () => exampleCatalog),
    installExamplePlugin: vi.fn(async (_id: string) => ({ ok: true })),
  }
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('usePlugins', () => {
  it('mount calls listPlugins and populates plugins/results', async () => {
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    expect(result.current.plugins[0].id).toBe('plugin-a')
    expect(result.current.results['plugin-a'].ok).toBe(true)
    expect((window as any).forge.listPlugins).toHaveBeenCalledTimes(1)
  })

  it('subscribes to onPluginsChanged on mount and unsubscribes on unmount', async () => {
    const { result, unmount } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    expect((window as any).forge.onPluginsChanged).toHaveBeenCalledTimes(1)
    expect(pluginsChangedCb).not.toBeNull()
    unmount()
    expect(unsubCalled).toBe(true)
  })

  it('onPluginsChanged callback updates plugins and results', async () => {
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    const newSnap: PluginSnapshot = {
      plugins: [pluginA, pluginB],
      results: { 'plugin-a': resultA, 'plugin-b': resultB },
    }
    act(() => { pluginsChangedCb!(newSnap) })

    expect(result.current.plugins).toHaveLength(2)
    expect(result.current.plugins[1].id).toBe('plugin-b')
    expect(result.current.results['plugin-b'].ok).toBe(true)
  })

  it('usageByProvider groups statusbar-usage ok results by provider', async () => {
    const snap: PluginSnapshot = {
      plugins: [pluginA, pluginB],
      results: { 'plugin-a': resultA, 'plugin-b': resultB },
    }
    ;(window as any).forge.listPlugins = vi.fn(async () => snap)
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(2))

    expect(result.current.usageByProvider['claude']).toEqual(resultA.data)
    expect(result.current.usageByProvider['codex']).toEqual(resultB.data)
  })

  it('usageByProvider ignores non-statusbar-usage plugin type', async () => {
    const snap: PluginSnapshot = {
      plugins: [pluginC],
      results: { 'plugin-c': resultC },
    }
    ;(window as any).forge.listPlugins = vi.fn(async () => snap)
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    expect(result.current.usageByProvider['other-provider']).toBeUndefined()
  })

  it('usageByProvider ignores failed (non-ok) results', async () => {
    const snap: PluginSnapshot = {
      plugins: [pluginA],
      results: { 'plugin-a': resultFail },
    }
    ;(window as any).forge.listPlugins = vi.fn(async () => snap)
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    expect(result.current.usageByProvider['claude']).toBeUndefined()
  })

  it('usageByProvider ignores plugins with no provider', async () => {
    const snap: PluginSnapshot = {
      plugins: [pluginD],
      results: { 'plugin-d': resultA },
    }
    ;(window as any).forge.listPlugins = vi.fn(async () => snap)
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    // no provider → nothing keyed
    expect(Object.keys(result.current.usageByProvider)).toHaveLength(0)
  })

  it('install: pickDirectory → installPlugin(dir) clears installError on success', async () => {
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    await act(async () => { await result.current.install() })

    expect((window as any).forge.pickDirectory).toHaveBeenCalledTimes(1)
    expect((window as any).forge.installPlugin).toHaveBeenCalledWith('/some/dir')
    expect(result.current.installError).toBeNull()
  })

  it('install: sets installError when installPlugin returns not ok', async () => {
    ;(window as any).forge.installPlugin = vi.fn(async () => ({ ok: false, error: '清单无效' }))
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    await act(async () => { await result.current.install() })

    expect(result.current.installError).toBe('清单无效')
  })

  it('install: sets fallback installError when installPlugin returns no error message', async () => {
    ;(window as any).forge.installPlugin = vi.fn(async () => ({ ok: false }))
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    await act(async () => { await result.current.install() })

    expect(result.current.installError).toBe('安装失败')
  })

  it('install: does nothing when pickDirectory returns null', async () => {
    ;(window as any).forge.pickDirectory = vi.fn(async () => null)
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    await act(async () => { await result.current.install() })

    expect((window as any).forge.installPlugin).not.toHaveBeenCalled()
    expect(result.current.installError).toBeNull()
  })

  it('uninstall calls uninstallPlugin with the id', async () => {
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    await act(async () => { await result.current.uninstall('plugin-a') })

    expect((window as any).forge.uninstallPlugin).toHaveBeenCalledWith('plugin-a')
  })

  it('setEnabled calls setPluginEnabled with id and enabled flag', async () => {
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    await act(async () => { await result.current.setEnabled('plugin-a', false) })

    expect((window as any).forge.setPluginEnabled).toHaveBeenCalledWith({ id: 'plugin-a', enabled: false })
  })

  it('refresh calls refreshPlugins with optional id', async () => {
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.plugins).toHaveLength(1))

    await act(async () => { await result.current.refresh('plugin-a') })
    expect((window as any).forge.refreshPlugins).toHaveBeenCalledWith('plugin-a')

    await act(async () => { await result.current.refresh() })
    expect((window as any).forge.refreshPlugins).toHaveBeenCalledWith(undefined)
  })

  it('mount 时加载 catalog', async () => {
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.catalog.length).toBe(1))
    expect(result.current.catalog[0].id).toBe('forge-example-claude-usage')
  })

  it('installExample 成功不写 installError', async () => {
    const { result } = renderHook(() => usePlugins())
    await act(async () => { await result.current.installExample('forge-example-claude-usage') })
    expect(result.current.installError).toBeNull()
  })

  it('installExample 失败写 installError', async () => {
    ;(window as any).forge.installExamplePlugin = vi.fn().mockResolvedValueOnce({ ok: false, error: '装失败' })
    const { result } = renderHook(() => usePlugins())
    await act(async () => { await result.current.installExample('bad') })
    expect(result.current.installError).toBe('装失败')
  })
})
