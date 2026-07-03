// Renderer-facing plugin types. These mirror the shapes in src/main/plugins/pluginSchema.ts and
// src/main/plugins/pluginScheduler.ts WITHOUT importing from main-process modules (which would pull
// in Zod, Node built-ins, and Electron APIs into the renderer bundle).

export interface InstalledPlugin {
  id: string
  dir: string
  type: string
  provider?: string
  name: string
  entry: string
  refreshSec: number
  enabled: boolean
  native?: boolean
}

export interface PluginResult {
  ok: boolean
  type?: string
  data?: unknown
  error?: string
  at: number
}

export interface PluginSnapshot {
  plugins: InstalledPlugin[]
  results: Record<string, PluginResult>
}

export interface UsageWindow { used: number; limit: number; resetAt?: number }

export interface StatusbarUsage {
  window5h?: UsageWindow
  weekly?: UsageWindow
  label?: string
}

export interface CatalogEntry {
  id: string
  name: string
  description: string
  icon: string          // 图标 key（渲染层映射 svg），如 'gauge'
  type: string          // 'statusbar-usage'
  provider?: string
  installed: boolean     // 是否已在 integrations.json 中
  available: boolean      // 内置目录存在、可安装
}
