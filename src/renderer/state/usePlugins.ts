import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InstalledPlugin, PluginResult, StatusbarUsage, CatalogEntry } from '@shared/plugins'

export interface PluginsApi {
  plugins: InstalledPlugin[]
  results: Record<string, PluginResult>
  usageByProvider: Record<string, StatusbarUsage>
  catalog: CatalogEntry[]
  /** 拉取广场目录(会打远程「下架名单」端点)。只该由插件广场面板在打开时调用 —— 别放进任何常驻订阅。 */
  loadCatalog: () => void
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

  // ★ 刻意不在 mount 时加载 catalog。listPluginCatalog 会去打 Cloudflare Worker 拉「下架名单」,而这个
  // hook 挂在 App 根上 —— 放在这里等于每次启动 app(dev 下每次 HMR 重挂)都白打一次,用户可能根本不开
  // 插件广场。改成由「插件广场」那个面板自己在挂载时调 loadCatalog(),做到「不打开就不请求」。

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
      // ★ 这里不能顺手 loadCatalog():pluginScheduler 每个刷新周期都会广播一次(哪怕没有插件到期),
      // 跟着拉 catalog 就变成「app 开着就每分钟打一次 Worker」—— 60s 缓存只是把频率压到每分钟一次,
      // 并没有阻止请求。广场打开时的刷新由面板自己负责(见 PluginPane)。
    })
    return () => { unsub() }
  }, [])

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

  return { plugins, results, usageByProvider, catalog, loadCatalog, install, uninstall, setEnabled, refresh, installExample, installError, creds, setCred }
}
