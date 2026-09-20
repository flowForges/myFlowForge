import { join, relative, isAbsolute } from 'node:path'
import { execa } from 'execa'
import type { InstalledPlugin } from './pluginSchema'
import { EXTENSION_POINTS } from './extensionPoints'

export type PluginRunResult =
  | { ok: true; type: string; data: unknown }
  // retryAfterSec: the server's own `Retry-After` (429/503). When present the scheduler paces the
  // next attempt by it instead of its own backoff curve — see PluginScheduler.nextDelayMs.
  | { ok: false; error: string; retryAfterSec?: number }

// Injectable exec dep: returns { stdout, failed }
export type ExecRun = (
  entryAbs: string,
  cwd: string,
  extraEnv: Record<string, string>,
) => Promise<{ stdout: string; failed: boolean }>

// Only a minimal, explicit allowlist reaches an untrusted plugin subprocess. Never process.env,
// which carries secrets (ANTHROPIC_API_KEY and friends).
//
// The list is platform-specific because a bare-minimum environment is a classic Windows trap: a
// process started WITHOUT SystemRoot cannot initialise Winsock, so every network call inside the
// plugin fails with an error that points nowhere near the cause. PATHEXT is what lets a .cmd/.bat
// entry be resolved at all, and Windows sets USERPROFILE / TEMP rather than HOME / TMPDIR.
const ALLOWED_ENV: Record<'posix' | 'win32', string[]> = {
  posix: ['PATH', 'HOME', 'TMPDIR'],
  win32: ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'],
}

export function pluginEnv(parent: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const win = platform === 'win32'
  const out: Record<string, string> = {}
  for (const key of ALLOWED_ENV[win ? 'win32' : 'posix']) {
    const v = parent[key]
    // Omit rather than set empty: an empty HOME/TMPDIR is worse than none — code that checks for
    // presence takes it as configured and then resolves paths against ''.
    if (v !== undefined && v !== '') out[key] = v
  }
  // Plugins are written cross-platform and reach for HOME; mirror USERPROFILE into it on Windows.
  if (win && !out.HOME && out.USERPROFILE) out.HOME = out.USERPROFILE
  return out
}

const defaultExec: ExecRun = async (entryAbs, cwd, extraEnv) => {
  const safeEnv: Record<string, string> = { ...pluginEnv(process.env), ...extraEnv }
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
