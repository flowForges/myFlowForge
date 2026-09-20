import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { sysFile } from '../config/paths'
import { writeJsonAtomic } from '../util/atomicWrite'
import { OPENER_CATALOG, type OpenerSpec } from './catalog'
import { resolveFirstWindowsPath, type WinFsProbe } from './winPaths'
import { queryAppPath, type RegQuery } from './winRegistry'
import type { DetectedOpener } from '../../shared/openers'

const pexec = promisify(execFile)

// Resolve a bundle id to an installed .app path (or null). Async so the mdfind scan never blocks the
// main-process event loop (the old sync execFileSync × ~19 bundle ids stalled the UI on cold cache).
// Injectable for tests.
export type BundleFinder = (bundleId: string) => Promise<string | null>
// Best-effort app-icon → dataURL. Injected by the IPC handler (needs Electron's app.getFileIcon);
// detect.ts stays Electron-free so it's unit-testable.
export type IconFn = (appPath: string) => Promise<string | undefined>

// Everything platform detection needs, all injectable so the Windows path is testable on a Mac.
export interface DetectDeps {
  platform?: NodeJS.Platform
  icon?: IconFn
  findBundle?: BundleFinder   // macOS
  env?: NodeJS.ProcessEnv     // Windows
  fs?: WinFsProbe             // Windows
  reg?: RegQuery              // Windows
}

export const openersCacheFile = () => sysFile('openers-cache.json')
// Bump when the cache shape/contents change so old caches self-heal. v2 = entries carry app icons.
// v3 = icons are read from the app bundle's real .icns (v2 icons were generic getFileIcon
// placeholders on some macOS builds — an identical blank square for every app).
// v4 = entries carry `argStyle` (Windows launch shape) and the catalog is platform-scoped.
export const OPENERS_CACHE_VERSION = 4
const noIcon: IconFn = async () => undefined

async function mdfindBundle(bundleId: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`])
    return stdout.split('\n').map(s => s.trim()).find(Boolean) ?? null
  } catch { return null }
}

const realFsProbe: WinFsProbe = { exists: existsSync, readdir: (d) => readdirSync(d) }

// macOS: first installed (and still-existing) bundle id wins.
export async function findMacAppPath(spec: OpenerSpec, find: BundleFinder = mdfindBundle): Promise<string | null> {
  for (const id of spec.mac?.bundleIds ?? []) {
    const p = await find(id)
    if (p && existsSync(p)) return p
  }
  return null
}

// Windows: probe the known install locations first (cheap, no subprocess), then fall back to the
// registry's `App Paths` for installs in a location no template can guess.
export async function findWinAppPath(spec: OpenerSpec, deps: DetectDeps = {}): Promise<string | null> {
  const loc = spec.win
  if (!loc) return null
  const hit = resolveFirstWindowsPath(loc.paths, deps.env ?? process.env, deps.fs ?? realFsProbe)
  if (hit) return hit
  if (!loc.exe) return null
  return queryAppPath(loc.exe, deps.reg, (deps.fs ?? realFsProbe).exists)
}

// Scan the whole catalog for installed openers (+ icons). Runs all specs concurrently (order
// preserved) so the full scan is bounded by the slowest probe, not their sum.
export async function scanOpeners(deps: DetectDeps = {}): Promise<DetectedOpener[]> {
  const platform = deps.platform ?? process.platform
  const icon = deps.icon ?? noIcon
  const found = await Promise.all(OPENER_CATALOG.map(async (spec): Promise<DetectedOpener | null> => {
    const appPath = platform === 'win32'
      ? await findWinAppPath(spec, deps)
      : await findMacAppPath(spec, deps.findBundle)
    if (!appPath) return null
    return { id: spec.id, name: spec.name, openMode: spec.openMode, appPath, argStyle: spec.win?.argStyle, icon: await icon(appPath) }
  }))
  return found.filter((o): o is DetectedOpener => o !== null)
}

// Cached entry point for the IPC handler: read the on-disk cache unless `refresh`, else scan +
// persist. The scan (the slow part) only runs on a cold cache or explicit refresh.
export async function detectOpeners(icon: IconFn = noIcon, refresh = false, deps: DetectDeps = {}): Promise<DetectedOpener[]> {
  const file = openersCacheFile()
  if (!refresh && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const apps = Array.isArray(parsed?.apps) ? parsed.apps as DetectedOpener[] : null
      // Only trust a cache written by the current build (version tag). An older cache re-scans ONCE —
      // not on every call, even if icon extraction legitimately fails for some app.
      if (apps && parsed?.v === OPENERS_CACHE_VERSION) return apps
    } catch { /* corrupt cache — fall through to rescan */ }
  }
  const apps = await scanOpeners({ ...deps, icon })
  try { writeJsonAtomic(file, { v: OPENERS_CACHE_VERSION, apps }) } catch { /* cache write is best-effort */ }
  return apps
}

// Look up a detected opener by id (from an already-fetched list; no rescan). Used by open-with.
export function resolveOpener(id: string, apps: DetectedOpener[]): DetectedOpener | undefined {
  return apps.find(a => a.id === id)
}

// Lazy-refresh: drop an opener from the list (pure). The handler persists the result + tells the
// renderer, so a since-deleted app is removed on the next open attempt instead of via a full rescan.
export function withoutOpener(apps: DetectedOpener[], id: string): DetectedOpener[] {
  return apps.filter(a => a.id !== id)
}
