import { readFileSync, existsSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { PluginManifestSchema, type PluginManifest } from './pluginSchema'

export function parseManifest(
  dir: string,
): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  try {
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      return { ok: false, error: '缺少 manifest.json' }
    }

    let raw: string
    try {
      raw = readFileSync(manifestPath, 'utf-8')
    } catch {
      return { ok: false, error: '缺少 manifest.json' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'manifest.json 不是合法 JSON' }
    }

    const result = PluginManifestSchema.safeParse(parsed)
    if (!result.success) {
      return { ok: false, error: result.error.issues[0]?.message ?? result.error.message }
    }

    const manifest = result.data
    manifest.refreshSec = Math.max(30, manifest.refreshSec)

    const entryAbs = join(dir, manifest.entry)
    const rel = relative(dir, entryAbs)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, error: '入口文件不在插件目录内' }
    }

    if (!existsSync(entryAbs)) {
      return { ok: false, error: '入口文件不存在: ' + manifest.entry }
    }

    return { ok: true, manifest }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
