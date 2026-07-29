import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { sysFile } from '../config/paths'
import { resolveBackgroundAbs } from './backgroundStore'

// A tiny persistent cache mapping a remote image KEY → the on-disk background file (rel path) we already
// downloaded for it. Preview thumbnails are content-addressed by the DOWNLOADED bytes, so the store can
// only dedupe *writes* after a download — it can't avoid the download itself. This index closes that gap:
// keyed by something known BEFORE any network call, it lets nsfwPreview / wallpaperPreview return the
// cached forge-bg:// file with ZERO network when that key was fetched before. That's what stops the
// "every Settings open re-downloads every NSFW thumbnail from the Cloudflare Worker" churn.
//
// The key is deliberately NOT the literal fetch URL: the NSFW URL carries the activation code as a query
// param, which must not be written to a plaintext index. Callers pass a stable, non-secret key (the
// Worker path, or the wallpaper thumb URL).

export interface PreviewCache {
  // rel path of the cached file for this key, or null if未缓存 or the file was GC'd (→ caller re-fetches).
  lookup(key: string): string | null
  // Remember that `key` resolved to on-disk file `rel`.
  record(key: string, rel: string): void
}

// LRU cap. NSFW (≈23) + built-in 壁纸 (≈100) previews fit easily; the bound guards against unbounded
// growth as catalogs churn over time.
const INDEX_MAX = 400

interface Persisted { version: 1; entries: [string, string][] }

function indexPath(): string { return sysFile('preview-index.json') }

function loadEntries(path: string): Map<string, string> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Persisted
    if (raw && Array.isArray(raw.entries)) {
      return new Map(raw.entries.filter((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string'))
    }
  } catch { /* missing / corrupt → start empty */ }
  return new Map()
}

function persist(path: string, map: Map<string, string>): void {
  const entries = [...map.entries()]
  // Insertion order is LRU order (record re-inserts at the end); drop the oldest beyond the cap.
  const trimmed = entries.length > INDEX_MAX ? entries.slice(entries.length - INDEX_MAX) : entries
  try { writeFileSync(path, JSON.stringify({ version: 1, entries: trimmed } satisfies Persisted)) } catch { /* best-effort */ }
}

// Build a disk-backed preview cache. Loads the index once into memory (avoids read races between the many
// concurrent preview calls a gallery fires), verifies the file still exists on lookup (self-heals if GC
// removed it), and persists on every record.
export function makeDiskPreviewCache(path: string = indexPath(), bgDir?: string): PreviewCache {
  const map = loadEntries(path)
  return {
    lookup(key) {
      const rel = map.get(key)
      if (!rel) return null
      const abs = resolveBackgroundAbs(rel, bgDir)
      if (!abs || !existsSync(abs)) { map.delete(key); persist(path, map); return null }   // file GC'd → forget it (+ scrub disk), re-fetch
      map.delete(key); map.set(key, rel)                              // refresh recency (persisted on next record)
      return rel
    },
    record(key, rel) {
      map.delete(key); map.set(key, rel)
      persist(path, map)
    },
  }
}

// All rels currently referenced by the preview index — added to the backgrounds GC keep-set so cached
// preview thumbnails survive startup/pick GC instead of being wiped and re-downloaded next session.
export function previewKeepRels(path: string = indexPath()): string[] {
  return [...loadEntries(path).values()]
}
