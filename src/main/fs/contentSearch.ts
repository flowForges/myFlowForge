import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, relative, sep } from 'node:path'
import type { ContentHit, ContentSearchResult } from '@shared/types'

export type { ContentHit, ContentSearchResult }

// Directories never worth grepping (build output / VCS / deps). Mirrors fileTree.SKIP_DIRS.
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.forge', 'dist', 'out', '.next', 'target', '.venv', '__pycache__',
])

export const DEFAULTS = {
  maxFileBytes: 2_000_000, // skip files larger than 2 MB (likely generated / not source)
  maxFiles: 5000, // cap the walk so a giant tree can't wedge the search
  maxHits: 500, // stop after this many hits and flag `truncated`
  previewMax: 200, // truncate each matched line to keep the payload light
}

// Minimal fs surface so the core is unit-testable with an in-memory fake (no disk).
export interface FileEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}
export interface SearchFs {
  readdir(dir: string): FileEntry[]
  readFile(path: string): Buffer
  size(path: string): number
}

export interface SearchOpts {
  root: string
  query: string
  /** When given, search ONLY these paths (relative to root). Else walk the whole root. */
  files?: string[]
  maxFileBytes?: number
  maxFiles?: number
  maxHits?: number
  previewMax?: number
}

// A buffer is treated as binary (and skipped) if any NUL byte appears in the first 8 KB —
// the same cheap heuristic ripgrep/git use.
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

// Depth-first walk collecting file paths (relative to root, forward-slashed), skipping
// SKIP_DIRS and bounded by maxFiles.
function walk(fs: SearchFs, root: string, maxFiles: number): string[] {
  const files: string[] = []
  const stack = [root]
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop()!
    let entries: FileEntry[]
    try { entries = fs.readdir(dir) } catch { continue }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full)
      } else if (e.isFile()) {
        files.push(relative(root, full).split(sep).join('/'))
        if (files.length >= maxFiles) break
      }
    }
  }
  return files
}

// Pure(-ish) core: searches file CONTENTS for `query` (case-insensitive substring) over an
// injectable fs. Returns per-line hits with a truncated preview, capped at maxHits.
export function searchContentFs(opts: SearchOpts, fs: SearchFs): ContentSearchResult {
  const query = opts.query.trim()
  if (!query) return { hits: [], truncated: false }
  const maxFileBytes = opts.maxFileBytes ?? DEFAULTS.maxFileBytes
  const maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles
  const maxHits = opts.maxHits ?? DEFAULTS.maxHits
  const previewMax = opts.previewMax ?? DEFAULTS.previewMax
  const needle = query.toLowerCase()

  const files = opts.files && opts.files.length
    ? opts.files.map((f) => f.split(sep).join('/'))
    : walk(fs, opts.root, maxFiles)

  const hits: ContentHit[] = []
  let truncated = false
  for (const rel of files) {
    if (hits.length >= maxHits) { truncated = true; break }
    const full = join(opts.root, rel)
    let size: number
    try { size = fs.size(full) } catch { continue }
    if (size > maxFileBytes) continue
    let buf: Buffer
    try { buf = fs.readFile(full) } catch { continue }
    if (isBinary(buf)) continue
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ file: rel, line: i + 1, preview: truncate(lines[i], previewMax) })
        if (hits.length >= maxHits) { truncated = true; break }
      }
    }
  }
  return { hits, truncated }
}

const realFs: SearchFs = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
  readFile: (p) => readFileSync(p),
  size: (p) => statSync(p).size,
}

// Try ripgrep for speed; returns null if rg is unavailable or errored so callers fall back.
function ripgrep(opts: SearchOpts): Promise<ContentSearchResult | null> {
  const maxHits = opts.maxHits ?? DEFAULTS.maxHits
  const previewMax = opts.previewMax ?? DEFAULTS.previewMax
  const args = [
    '--no-heading', '--line-number', '--with-filename', '--color', 'never',
    '--fixed-strings', '--ignore-case',
    '--max-filesize', String(opts.maxFileBytes ?? DEFAULTS.maxFileBytes),
    '-e', opts.query,
  ]
  // Restrict to the given files, else search the whole root ('.').
  const targets = opts.files && opts.files.length ? opts.files : ['.']
  return new Promise((resolve) => {
    execFile('rg', [...args, '--', ...targets], { cwd: opts.root, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      // rg exits 1 when there are simply no matches (not an error); exit 2 / ENOENT = real failure.
      const code = (err as (Error & { code?: number | string }) | null)?.code
      if (err && code !== 1) { resolve(null); return }
      const hits: ContentHit[] = []
      let truncated = false
      for (const raw of stdout.split('\n')) {
        if (!raw) continue
        if (hits.length >= maxHits) { truncated = true; break }
        const m = /^(.*?):(\d+):(.*)$/.exec(raw)
        if (!m) continue
        const file = m[1].replace(/^\.\//, '').split(sep).join('/')
        const t = m[3].trim()
        hits.push({ file, line: Number(m[2]), preview: t.length > previewMax ? t.slice(0, previewMax) + '…' : t })
      }
      resolve({ hits, truncated })
    })
  })
}

// Real entrypoint: ripgrep first, in-process fs walk as fallback.
export async function searchContent(opts: SearchOpts): Promise<ContentSearchResult> {
  if (!opts.query.trim()) return { hits: [], truncated: false }
  const rg = await ripgrep(opts)
  if (rg) return rg
  return searchContentFs(opts, realFs)
}
