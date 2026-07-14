import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { sysFile } from '../config/paths'

// Background images used to be inlined into settings.json as multi-MB base64 data URLs, which capped
// the size at ~6MB and bloated every settings read/write. They now live on disk under
// ~/.myFlowForge/backgrounds/<hash>.<ext> and are served through the forge-bg:// protocol; settings.json
// stores only the small protocol URL. Mirrors the pet-images design (see pet/petImageStore.ts).
export const BG_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

// Off-disk storage means we no longer need a tiny cap; keep a generous guard against pathological files.
export const MAX_BG_BYTES = 30_000_000

export const backgroundsDir = (): string => sysFile('backgrounds')

// Normalize an extension for on-disk storage: jpeg → jpg so a single content-hash maps to one file
// regardless of which spelling the source used.
function normalizeExt(ext: string): string {
  const e = ext.toLowerCase()
  return e === 'jpeg' ? 'jpg' : e
}

export type StoreBgResult = { rel: string } | { error: string }

// Copy an image from an arbitrary source path into the backgrounds dir under a content-addressed name
// (sha1 of the bytes), returning the stored relative path "<hash>.<ext>". Content addressing dedupes
// re-uploads of the same image and makes the served bytes safe to cache immutably. Returns { error }
// for unsupported formats or oversized files.
export function storeBackgroundFromPath(srcPath: string, baseDir: string = backgroundsDir()): StoreBgResult {
  const ext = srcPath.slice(srcPath.lastIndexOf('.') + 1).toLowerCase()
  if (!BG_MIME_BY_EXT[ext]) return { error: '不支持的图片格式,仅支持 png/jpg/webp/gif' }
  let size: number
  try { size = statSync(srcPath).size } catch { return { error: '图片读取失败' } }
  if (size > MAX_BG_BYTES) return { error: `图片过大,请选择 ${Math.floor(MAX_BG_BYTES / 1_000_000)}MB 以内的图片` }
  let bytes: Buffer
  try { bytes = readFileSync(srcPath) } catch { return { error: '图片读取失败' } }
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
  const rel = `${hash}.${normalizeExt(ext)}`
  mkdirSync(baseDir, { recursive: true })
  const abs = join(baseDir, rel)
  if (!existsSync(abs)) writeFileSync(abs, bytes)
  return { rel }
}

// Resolve a stored relative path to an absolute path INSIDE the backgrounds dir, or null if it would
// escape (path-traversal guard for the protocol handler).
export function resolveBackgroundAbs(rel: string, baseDir: string = backgroundsDir()): string | null {
  const root = resolve(baseDir)
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

// Extract the stored relative path from a forge-bg://img/<rel> URL, or null if it isn't one (e.g. a
// legacy inline data: URL or an empty value). Used to compute the set of still-referenced files.
export function bgRelFromUrl(value: string | undefined): string | null {
  if (!value || !value.startsWith(`${BG_SCHEME}://`)) return null
  try { return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, '')) || null } catch { return null }
}

// Delete any file in the backgrounds dir not referenced by `keep` (a set of relative paths). Best-effort:
// runs after a new pick and at startup so cleared/replaced images reclaim disk without risking deletion
// of a file another appearance field still points at.
export function gcBackgrounds(keep: Set<string>, baseDir: string = backgroundsDir()): number {
  let removed = 0
  let entries: string[]
  try { entries = readdirSync(baseDir) } catch { return 0 }
  for (const name of entries) {
    if (keep.has(name)) continue
    try { rmSync(join(baseDir, name)); removed++ } catch { /* best-effort */ }
  }
  return removed
}

// The forge-bg:// scheme name, kept here so store + protocol agree without a circular import.
export const BG_SCHEME = 'forge-bg'

// Build the served URL for a stored relative path. Host is a fixed "img" to mirror forge-pet://img/.
export function backgroundImageUrl(rel: string): string {
  return `${BG_SCHEME}://img/${rel}`
}
