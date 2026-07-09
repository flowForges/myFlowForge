import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { git } from '../git/gitRunner'
import type { TreeNode, ChangeItem } from '@shared/types'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.forge', 'dist', 'out', '.next', 'target', '.venv', '__pycache__'])
// Cap the file list from EITHER source (git ls-files or the fs walk) so the synchronous buildTree
// pass can't block the main process on a giant repo/tree. A partial tree beats a frozen UI.
const MAX_TREE_FILES = 4000

// Plain filesystem walk for directories that are NOT a git repo (e.g. a workspace root holding
// several project worktrees). ASYNC (awaits readdir, yielding to the event loop between every
// directory) so a large/slow tree can't synchronously wedge the main process — the old readdirSync
// version blocked it for ~29s on a big cloud-synced folder. Triple-bounded (files, dirs, wall-clock
// deadline) so even a pathological tree returns promptly with a partial view.
//
// BREADTH-FIRST (queue.shift, not stack.pop): a workspace root holds several sibling project folders,
// and a depth-first walk drains the first project's entire subtree before touching the next — so when
// the file cap hit inside one big project, the remaining projects were never visited and vanished
// from the tree ("only 2 of 5 projects show"). BFS lists every folder's immediate entries first, so
// the budget is spread fairly across siblings and every project surfaces.
//
// Emits a trailing-'/' marker for each directory entered, so a folder still becomes a node even when
// it holds no files within budget (a build-only or freshly-cloned project) — buildTree would
// otherwise only ever create a dir node when a FILE lives under it, silently dropping empty projects.
async function walkDir(root: string, maxFiles = MAX_TREE_FILES, maxDirs = 15000, deadlineMs = 6000): Promise<string[]> {
  const paths: string[] = []
  const queue = [root]
  let dirs = 0
  const start = Date.now()
  const rel = (p: string) => relative(root, p).split(sep).join('/')
  while (queue.length && paths.length < maxFiles && dirs < maxDirs) {
    if (Date.now() - start > deadlineMs) break
    const dir = queue.shift()!
    dirs++
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        paths.push(rel(full) + '/')   // dir marker → folder shows even if empty/truncated
        queue.push(full)
      } else {
        paths.push(rel(full)); if (paths.length >= maxFiles) break
      }
    }
  }
  return paths
}

export function buildTree(files: string[], changes: ChangeItem[] = []): TreeNode[] {
  const chg = new Map(changes.map(c => [c.path, c.type]))
  const root: TreeNode[] = []
  for (const raw of files) {
    // A trailing '/' marks a directory path (emitted by walkDir so empty folders still show); plain
    // paths (git ls-files output, or files) have no trailing slash and their last segment is a file.
    const isDirPath = raw.endsWith('/')
    const parts = raw.split('/').filter(Boolean)
    let level = root
    let prefix = ''
    parts.forEach((part, i) => {
      prefix = prefix ? `${prefix}/${part}` : part
      const isFile = i === parts.length - 1 && !isDirPath
      let node = level.find(n => n.name === part && (isFile ? n.type === 'file' : n.type === 'dir'))
      if (!node) {
        node = isFile
          ? { type: 'file', name: part, path: prefix, chg: chg.get(prefix) }
          : { type: 'dir', name: part, path: prefix, children: [] }
        level.push(node)
      }
      if (!isFile && node.children) level = node.children
    })
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))
    for (const n of nodes) if (n.children) sortRec(n.children)
  }
  sortRec(root)
  return root
}

export async function readTree(cwd: string, changes: ChangeItem[] = [], proxy = ''): Promise<TreeNode[]> {
  let files: string[]
  try {
    const out = await git(['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, proxy })
    files = [...new Set(out.split('\n').filter(Boolean))]
    if (files.length > MAX_TREE_FILES) files = files.slice(0, MAX_TREE_FILES)
    // A non-git dir (e.g. the workspace root over several project worktrees) returns nothing
    // from ls-files — fall back to a plain filesystem walk so its tree still shows.
    if (files.length === 0) files = await walkDir(cwd)
  } catch {
    files = await walkDir(cwd)
  }
  return buildTree(files, changes)
}
