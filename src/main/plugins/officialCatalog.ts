import type { CatalogEntry } from '@shared/plugins'
import type { InstalledPlugin } from './pluginSchema'
import { PluginsFileSchema } from './pluginSchema'
import { readPlugins } from './pluginStore'
import { readJson, writeJson } from '../config/store'
import { pluginsFile } from '../config/paths'

interface OfficialDef { provider: string; name: string; description: string }

export const OFFICIAL_PROVIDERS: OfficialDef[] = [
  { provider: 'codex',  name: 'Codex 额度 · 官方',  description: '读取本机 Codex 登录态，显示真实 5 小时 / 每周额度与重置时间。' },
  { provider: 'claude', name: 'Claude 额度 · 官方', description: '读取 macOS 钥匙串中的 Claude 登录态（首次需授权），显示真实额度。' },
  { provider: 'gemini', name: 'Gemini 额度 · 官方', description: '读取 Gemini CLI 登录态，显示配额剩余与重置时间。' },
  { provider: 'cursor', name: 'Cursor 额度 · 官方', description: '读取本机 Cursor 登录态，显示套餐用量与账单周期。' },
  { provider: 'qoder',  name: 'Qoder 额度 · 官方',  description: '暂无可读数据源，连接后显示真实额度。' },
]

const idFor = (provider: string) => `forge-official-${provider}-usage`

export function listCatalog(): CatalogEntry[] {
  const installed = new Set(readPlugins().map(p => p.id))
  return OFFICIAL_PROVIDERS.map(d => ({
    id: idFor(d.provider),
    name: d.name,
    description: d.description,
    icon: 'gauge',
    type: 'statusbar-usage',
    provider: d.provider,
    installed: installed.has(idFor(d.provider)),
    available: true,
  }))
}

export function installOfficial(id: string): { ok: true } | { ok: false; error: string } {
  const def = OFFICIAL_PROVIDERS.find(d => idFor(d.provider) === id)
  if (!def) return { ok: false, error: '未知官方插件: ' + id }
  const existing = readPlugins()
  const prior = existing.find(p => p.id === id)
  const plugin: InstalledPlugin = {
    id, dir: '', type: 'statusbar-usage', provider: def.provider,
    name: def.name, entry: 'native', refreshSec: 300,
    enabled: prior?.enabled ?? true, native: true,
  }
  const updated = prior ? existing.map(p => (p.id === id ? plugin : p)) : [...existing, plugin]
  writeJson(pluginsFile(), PluginsFileSchema.parse({ plugins: updated }))
  return { ok: true }
}
