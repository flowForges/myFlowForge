import type { CatalogEntry } from '@shared/plugins'
import type { InstalledPlugin } from './pluginSchema'
import { PluginsFileSchema } from './pluginSchema'
import { readPlugins } from './pluginStore'
import { readJson, writeJson } from '../config/store'
import { pluginsFile } from '../config/paths'
import { PET_MARKET_PLUGIN_ID } from '@shared/codexPetMarket'

interface OfficialDef { provider: string; name: string; description: string }

export const OFFICIAL_PROVIDERS: OfficialDef[] = [
  { provider: 'codex',  name: 'Codex 额度 · 官方',  description: '读取本机 Codex 登录态，显示真实 5 小时 / 每周额度与重置时间。' },
  { provider: 'claude', name: 'Claude 额度 · 官方', description: '读取 macOS 钥匙串中的 Claude 登录态（首次需授权），显示真实额度。' },
  { provider: 'gemini', name: 'Gemini 额度 · 官方', description: '读取 Gemini CLI 登录态，显示配额剩余与重置时间。' },
  { provider: 'cursor', name: 'Cursor 额度 · 官方', description: '读取本机 Cursor 登录态，显示套餐用量与账单周期。' },
  { provider: 'qoder',  name: 'Qoder 额度 · 官方',  description: '暂无可读数据源，连接后显示真实额度。' },
]

// 「功能」官方插件(非 statusbar-usage provider):启用后解锁一块 App 内功能。目前只有 codex 宠物市场——
// 装/启用它 → 设置里出现「宠物市场」页(App 据 plugins 里它是否 enabled 决定,见 PET_MARKET_PLUGIN_ID)。
interface OfficialFeatureDef { id: string; name: string; description: string; type: string; icon: string }
export const OFFICIAL_FEATURES: OfficialFeatureDef[] = [
  {
    id: PET_MARKET_PLUGIN_ID, name: 'codex 宠物市场', type: 'pet-market', icon: 'gauge',
    description: '浏览并一键安装 codex-pets.net 社区宠物(第三方来源,已标注作者)。启用后在设置里出现「宠物市场」页。',
  },
]

const idFor = (provider: string) => `forge-official-${provider}-usage`

export function listCatalog(): CatalogEntry[] {
  const installed = new Set(readPlugins().map(p => p.id))
  const providers: CatalogEntry[] = OFFICIAL_PROVIDERS.map(d => ({
    id: idFor(d.provider),
    name: d.name,
    description: d.description,
    icon: 'gauge',
    type: 'statusbar-usage',
    provider: d.provider,
    installed: installed.has(idFor(d.provider)),
    available: true,
  }))
  const features: CatalogEntry[] = OFFICIAL_FEATURES.map(f => ({
    id: f.id, name: f.name, description: f.description, icon: f.icon, type: f.type,
    installed: installed.has(f.id), available: true,
  }))
  return [...providers, ...features]
}

export function installOfficial(id: string): { ok: true } | { ok: false; error: string } {
  const feature = OFFICIAL_FEATURES.find(f => f.id === id)
  const provider = OFFICIAL_PROVIDERS.find(d => idFor(d.provider) === id)
  if (!feature && !provider) return { ok: false, error: '未知官方插件: ' + id }
  const existing = readPlugins()
  const prior = existing.find(p => p.id === id)
  const plugin: InstalledPlugin = feature
    ? { id, dir: '', type: feature.type, name: feature.name, entry: 'native', refreshSec: 300, enabled: prior?.enabled ?? true, native: true }
    : { id, dir: '', type: 'statusbar-usage', provider: provider!.provider, name: provider!.name, entry: 'native', refreshSec: 300, enabled: prior?.enabled ?? true, native: true }
  const updated = prior ? existing.map(p => (p.id === id ? plugin : p)) : [...existing, plugin]
  writeJson(pluginsFile(), PluginsFileSchema.parse({ plugins: updated }))
  return { ok: true }
}
