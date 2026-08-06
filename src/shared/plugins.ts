// Renderer-facing plugin types. These mirror the shapes in src/main/plugins/pluginSchema.ts and
// src/main/plugins/pluginScheduler.ts WITHOUT importing from main-process modules (which would pull
// in Zod, Node built-ins, and Electron APIs into the renderer bundle).

import { NSFW_WORKER_URL } from './nsfw'

// 插件广场远程下架名单 —— 一个 public 的 GET 端点(无需激活码),返回 { blocked: [...ids] }。改 Worker 的
// PLUGIN_BLOCKLIST 变量即可即时把某个有问题的插件从「插件广场」里隐藏(已安装用户不受影响)。复用 NSFW Worker
// 的地址(同一个 Worker),NSFW 未配置时此项为空 → 下架功能休眠(不隐藏任何插件)。见 cloudflare/nsfw-worker.js。
export const PLUGIN_BLOCKLIST_URL = NSFW_WORKER_URL.trim()
  ? `${NSFW_WORKER_URL.trim().replace(/\/+$/, '')}/plugins-blocklist`
  : ''

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
