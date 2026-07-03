import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { git } from '../git/gitRunner'
import type { TreeNode, ChangeItem } from '@shared/types'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.forge', 'dist', 'out', '.next', 'target', '.venv', '__pycache__'])

// Plain filesystem walk for directories that are NOT a git repo (e.g. a workspace root
// holding several project worktrees). Bounded so a huge tree can't wedge the UI.
function walkDir(root: string, maxFiles = 4000): string[] {
  const files: string[] = []
  const stack = [root]
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name)) }
      else { files.push(relative(root, join(dir, e.name)).split(sep).join('/')); if (files.length >= maxFiles) break }
    }
  }
  return files
}

export function buildTree(files: string[], changes: ChangeItem[] = []): TreeNode[] {
  const chg = new Map(changes.map(c => [c.path, c.type]))
  const root: TreeNode[] = []
  for (const file of files) {
    const parts = file.split('/').filter(Boolean)
    let level = root
    let prefix = ''
    parts.forEach((part, i) => {
      prefix = prefix ? `${prefix}/${part}` : part
      const isFile = i === parts.length - 1
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
    // A non-git dir (e.g. the workspace root over several project worktrees) returns nothing
    // from ls-files — fall back to a plain filesystem walk so its tree still shows.
    if (files.length === 0) files = walkDir(cwd)
  } catch {
    files = walkDir(cwd)
  }
  return buildTree(files, changes)
}
