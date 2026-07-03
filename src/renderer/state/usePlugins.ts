import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InstalledPlugin, PluginResult, StatusbarUsage, CatalogEntry } from '@shared/plugins'

export interface PluginsApi {
  plugins: InstalledPlugin[]
  results: Record<string, PluginResult>
  usageByProvider: Record<string, StatusbarUsage>
  catalog: CatalogEntry[]
  install: () => Promise<void>
  uninstall: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  refresh: (id?: string) => Promise<void>
  installExample: (id: string) => Promise<void>
  installError: string | null
  creds: Record<string, string>
  setCred: (provider: string, value: string) => Promise<void>
}

export function usePlugins(): PluginsApi {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [results, setResults] = useState<Record<string, PluginResult>>({})
  const [installError, setInstallError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [creds, setCreds] = useState<Record<string, string>>({})

  const loadCatalog = useCallback(() => {
    void window.forge.listPluginCatalog().then(setCatalog)
  }, [])

  // Mount: load initial snapshot
  useEffect(() => {
    let live = true
    void window.forge.listPlugins().then(snap => {
      if (!live) return
      setPlugins(snap.plugins)
      setResults(snap.results)
    })
    return () => { live = false }
  }, [])

  // Mount: 初次加载 catalog
  useEffect(() => { loadCatalog() }, [loadCatalog])

  // Mount: load user-pasted plugin credentials (optional API → guard for older preloads/tests)
  useEffect(() => {
    if (!window.forge.getPluginCreds) return
    let live = true
    void window.forge.getPluginCreds().then(c => { if (live) setCreds(c) })
    return () => { live = false }
  }, [])

  const setCred = useCallback(async (provider: string, value: string): Promise<void> => {
    if (!window.forge.setPluginCred) return
    setCreds(await window.forge.setPluginCred(provider, value))
  }, [])

  // Subscribe to live updates
  useEffect(() => {
    const unsub = window.forge.onPluginsChanged(snap => {
      setPlugins(snap.plugins)
      setResults(snap.results)
      loadCatalog()
    })
    return () => { unsub() }
  }, [loadCatalog])

  // Derived: usageByProvider from statusbar-usage ok results
  const usageByProvider = useMemo<Record<string, StatusbarUsage>>(() => {
    const out: Record<string, StatusbarUsage> = {}
    for (const pluginId of Object.keys(results)) {
      const result = results[pluginId]
      if (!result.ok || !result.data) continue
      const plugin = plugins.find(p => p.id === pluginId)
      if (!plugin || plugin.type !== 'statusbar-usage' || !plugin.provider) continue
      out[plugin.provider] = result.data as StatusbarUsage
    }
    return out
  }, [results, plugins])

  // Actions — wrapped in useCallback (deps []) so consumers don't re-render on every hook call;
  // all side-effects call window.forge which is stable across renders.
  const install = useCallback(async (): Promise<void> => {
    const dir = await window.forge.pickDirectory()
    if (!dir) return
    const r = await window.forge.installPlugin(dir)
    if (!r?.ok) {
      setInstallError(r?.error ?? '安装失败')
    } else {
      setInstallError(null)
    }
  }, [])

  const uninstall = useCallback(async (id: string): Promise<void> => {
    await window.forge.uninstallPlugin(id)
  }, [])

  const setEnabled = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    await window.forge.setPluginEnabled({ id, enabled })
  }, [])

  const refresh = useCallback(async (id?: string): Promise<void> => {
    await window.forge.refreshPlugins(id)
  }, [])

  const installExample = useCallback(async (id: string): Promise<void> => {
    const r = await window.forge.installExamplePlugin(id)
    if (!r?.ok) setInstallError(r?.error ?? '安装失败')
    else setInstallError(null)
  }, [])

  return { plugins, results, usageByProvider, catalog, install, uninstall, setEnabled, refresh, installExample, installError, creds, setCred }
}
