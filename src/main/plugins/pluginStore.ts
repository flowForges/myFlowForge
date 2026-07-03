import { readJson, writeJson } from '../config/store'
import { pluginsFile } from '../config/paths'
import { PluginsFileSchema, type InstalledPlugin } from './pluginSchema'
import { parseManifest } from './pluginManifest'

function writePlugins(list: InstalledPlugin[]): void {
  writeJson(pluginsFile(), PluginsFileSchema.parse({ plugins: list }))
}

export function readPlugins(): InstalledPlugin[] {
  return readJson(pluginsFile(), PluginsFileSchema, () => ({ plugins: [] })).plugins
}

export function installPlugin(
  dir: string,
): { ok: true; plugin: InstalledPlugin } | { ok: false; error: string } {
  const result = parseManifest(dir)
  if (!result.ok) return { ok: false, error: result.error }

  const { manifest } = result
  const existing = readPlugins()
  const prior = existing.find(p => p.id === manifest.id)

  const plugin: InstalledPlugin = {
    id: manifest.id,
    dir,
    type: manifest.type,
    provider: manifest.provider,
    name: manifest.name,
    entry: manifest.entry,
    refreshSec: manifest.refreshSec,
    enabled: prior !== undefined ? prior.enabled : true,
    native: manifest.native,
  }

  const updated = prior !== undefined
    ? existing.map(p => (p.id === plugin.id ? plugin : p))
    : [...existing, plugin]

  writePlugins(updated)
  return { ok: true, plugin }
}

export function uninstallPlugin(id: string): void {
  const list = readPlugins().filter(p => p.id !== id)
  writePlugins(list)
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  const list = readPlugins().map(p => (p.id === id ? { ...p, enabled } : p))
  writePlugins(list)
}
