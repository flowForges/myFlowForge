import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { sysFile } from '../config/paths'
import { writeJsonAtomic } from '../util/atomicWrite'
import { OPENER_CATALOG, type OpenerSpec } from './catalog'
import type { DetectedOpener } from '../../shared/openers'

const pexec = promisify(execFile)

// Resolve a bundle id to an installed .app path (or null). Async so the mdfind scan never blocks the
// main-process event loop (the old sync execFileSync × ~19 bundle ids stalled the UI on cold cache).
// Injectable for tests.
export type BundleFinder = (bundleId: string) => Promise<string | null>
// Best-effort app-icon → dataURL. Injected by the IPC handler (needs Electron's app.getFileIcon);
// detect.ts stays Electron-free so it's unit-testable.
export type IconFn = (appPath: string) => Promise<string | undefined>

export const openersCacheFile = () => sysFile('openers-cache.json')
// Bump when the cache shape/contents change so old caches self-heal. v2 = entries carry app icons.
export const OPENERS_CACHE_VERSION = 2
const noIcon: IconFn = async () => undefined

async function mdfindBundle(bundleId: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`])
    return stdout.split('\n').map(s => s.trim()).find(Boolean) ?? null
  } catch { return null }
}

// First installed (and still-existing) bundle id wins.
export async function findAppPath(spec: OpenerSpec, find: BundleFinder = mdfindBundle): Promise<string | null> {
  for (const id of spec.bundleIds) {
    const p = await find(id)
    if (p && existsSync(p)) return p
  }
  return null
}

// Scan the whole catalog for installed openers (+ icons). Runs all specs concurrently (order
// preserved) so the full scan is bounded by the slowest mdfind, not their sum. `find`/`icon`
// injectable for tests.
export async function scanOpeners(icon: IconFn = noIcon, find: BundleFinder = mdfindBundle): Promise<DetectedOpener[]> {
  const found = await Promise.all(OPENER_CATALOG.map(async (spec): Promise<DetectedOpener | null> => {
    const appPath = await findAppPath(spec, find)
    if (!appPath) return null
    return { id: spec.id, name: spec.name, openMode: spec.openMode, appPath, icon: await icon(appPath) }
  }))
  return found.filter((o): o is DetectedOpener => o !== null)
}

// Cached entry point for the IPC handler: read the on-disk cache unless `refresh`, else scan +
// persist. The `mdfind` scan (the slow part) only runs on a cold cache or explicit refresh.
export async function detectOpeners(icon: IconFn = noIcon, refresh = false): Promise<DetectedOpener[]> {
  const file = openersCacheFile()
  if (!refresh && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const apps = Array.isArray(parsed?.apps) ? parsed.apps as DetectedOpener[] : null
      // Only trust a cache written by an icon-capable build (version tag). A pre-icon cache lacks it,
      // so it re-scans ONCE to extract icons (placeholder glyphs self-heal) — not on every call, even
      // if getFileIcon legitimately fails for some app (the re-written v-tagged cache is then trusted).
      if (apps && parsed?.v === OPENERS_CACHE_VERSION) return apps
    } catch { /* corrupt cache — fall through to rescan */ }
  }
  const apps = await scanOpeners(icon)
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
