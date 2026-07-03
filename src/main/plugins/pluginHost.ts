import { join, relative, isAbsolute } from 'node:path'
import { execa } from 'execa'
import type { InstalledPlugin } from './pluginSchema'
import { EXTENSION_POINTS } from './extensionPoints'

export type PluginRunResult =
  | { ok: true; type: string; data: unknown }
  | { ok: false; error: string }

// Injectable exec dep: returns { stdout, failed }
export type ExecRun = (
  entryAbs: string,
  cwd: string,
  extraEnv: Record<string, string>,
) => Promise<{ stdout: string; failed: boolean }>

const defaultExec: ExecRun = async (entryAbs, cwd, extraEnv) => {
  // Only pass a minimal, explicit allowlist to untrusted plugin subprocesses.
  // Never forward process.env which contains secrets (ANTHROPIC_API_KEY, etc.).
  const safeEnv: Record<string, string> = {
    PATH: String(process.env.PATH ?? ''),
    HOME: String(process.env.HOME ?? ''),
    TMPDIR: String(process.env.TMPDIR ?? process.env.TEMP ?? ''),
    ...extraEnv,
  }
  const r = await execa(entryAbs, [], {
    cwd,
    env: safeEnv,
    reject: false,
    timeout: 15000,
  })
  return {
    stdout: r.stdout ?? '',
    failed: r.failed || r.timedOut || r.exitCode !== 0,
  }
}

export async function runPlugin(
  plugin: InstalledPlugin,
  deps?: { exec?: ExecRun },
): Promise<PluginRunResult> {
  try {
    const ep = EXTENSION_POINTS[plugin.type]
    if (!ep) return { ok: false, error: '不支持的类型: ' + plugin.type }

    // Containment checked at install (parseManifest) and again here (defense-in-depth; integrations.json is user-editable).
    const entryAbs = join(plugin.dir, plugin.entry)
    // Defense-in-depth: re-check containment at run time.
    // integrations.json is user-editable so install-time guard alone is insufficient.
    const rel = relative(plugin.dir, entryAbs)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, error: '入口路径越界' }
    }
    const exec = deps?.exec ?? defaultExec

    const extraEnv: Record<string, string> = {
      FORGE_PLUGIN_TYPE: plugin.type,
      FORGE_PROVIDER: plugin.provider ?? '',
    }

    const out = await exec(entryAbs, plugin.dir, extraEnv)

    if (out.failed) return { ok: false, error: '插件执行失败/超时' }
    if (!out.stdout.trim()) return { ok: false, error: '插件无输出' }

    let parsed: unknown
    try {
      parsed = JSON.parse(out.stdout)
    } catch {
      return { ok: false, error: '插件输出不是合法 JSON' }
    }

    const v = ep.validate(parsed)
    return v.ok
      ? { ok: true, type: plugin.type, data: v.data }
      : { ok: false, error: v.error }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
