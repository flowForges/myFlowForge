import { readdirSync, existsSync } from 'node:fs'
import { join, relative, sep, basename } from 'node:path'
import { readBranch } from '../git/changes'

export interface DetectedRepo { name: string; relPath: string; absPath: string; branch: string }

// Heavy/irrelevant dirs never worth descending into when scanning an arbitrary folder for existing
// git repos (mirrors fileTree.ts's SKIP_DIRS, plus a couple more common ones since this walks
// user-picked folders that may hold node/python/build artifacts we've never seen before).
const SKIP = new Set(['.git', 'node_modules', '.forge', 'dist', 'build', 'target', '.venv', 'vendor', '.next', 'coverage'])
const MAX_DEPTH = 3
const MAX_REPOS = 60

// Collect repo root dirs (absolute paths) under `root`, bounded by depth/count. A dir counts as a
// repo the moment it has a `.git` entry — dir (normal repo) OR file (linked worktree/submodule) — and
// is treated as a LEAF: we do not recurse into it, so its own submodules/nested .git dirs never show
// up as separate top-level projects.
function collect(dir: string, depth: number, out: string[]): void {
  if (out.length >= MAX_REPOS) return
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  if (existsSync(join(dir, '.git'))) { out.push(dir); return }
  if (depth >= MAX_DEPTH) return
  for (const e of entries) {
    if (out.length >= MAX_REPOS) return
    if (!e.isDirectory() || SKIP.has(e.name)) continue
    collect(join(dir, e.name), depth + 1, out)
  }
}

// Dedupe basename collisions (two repos both named e.g. "shared") by suffixing -2, -3, ... — the
// workspace uses `name` as the worktree dir, so collisions would otherwise clash on disk.
function dedupeName(name: string, used: Map<string, number>): string {
  const n = (used.get(name) ?? 0) + 1
  used.set(name, n)
  return n === 1 ? name : `${name}-${n}`
}

export async function scanRepos(root: string): Promise<DetectedRepo[]> {
  if (!existsSync(root)) return []
  const dirs: string[] = []
  collect(root, 0, dirs)
  const used = new Map<string, number>()
  const repos: DetectedRepo[] = []
  for (const absPath of dirs) {
    const name = dedupeName(basename(absPath), used)
    const relPath = relative(root, absPath).split(sep).join('/')
    const branch = await readBranch(absPath).catch(() => '')
    repos.push({ name, relPath, absPath, branch })
  }
  return repos
}
