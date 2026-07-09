import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './gitRunner'
import type { ChangeItem, ChangeType, MultiChanges } from '@shared/types'
export type { MultiChanges }

// The branch to show for a project worktree: the pull baseline (its upstream / origin's default,
// e.g. "main"), falling back to the checked-out branch. '' when the dir isn't a git repo.
export async function readBranch(cwd: string, proxy = ''): Promise<string> {
  for (const args of [
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
  ]) {
    try { const r = (await git(args, { cwd, proxy })).trim().replace(/^origin\//, ''); if (r) return r } catch { /* try next */ }
  }
  // `branch --show-current` returns the branch even on an UNBORN branch (fresh repo, no commit yet),
  // where `rev-parse --abbrev-ref HEAD` just says "HEAD".
  try { const r = (await git(['branch', '--show-current'], { cwd, proxy })).trim(); if (r) return r } catch { /* not a repo */ }
  try { const r = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, proxy })).trim(); if (r && r !== 'HEAD') return r } catch { /* not a repo */ }
  return ''
}

function parseNumstat(numstat: string): Map<string, { add: number; del: number }> {
  const stat = new Map<string, { add: number; del: number }>()
  for (const l of numstat.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = l.split('\t')
    stat.set(rest.join('\t'), { add: a === '-' ? 0 : Number(a), del: d === '-' ? 0 : Number(d) })
  }
  return stat
}

function countLines(cwd: string, path: string): number {
  try { const text = readFileSync(join(cwd, path), 'utf8'); return text.length ? text.replace(/\n$/, '').split('\n').length : 0 }
  catch { return 0 }
}

// 「本次会话变更」relative to the pull baseline: everything that differs between the fork point (the
// branch's upstream, e.g. origin/main, set at worktree creation) and NOW — committed OR uncommitted —
// plus genuinely-new untracked files. ORIGINAL pulled files never appear. This replaces a plain
// `git status`, which lists every untracked file as "新建" and so painted a freshly-pulled (or
// not-yet-committed / unborn) worktree entirely green.
async function readChangesVsBase(cwd: string, base: string, proxy: string): Promise<ChangeItem[]> {
  let nameStatus = ''
  try { nameStatus = await git(['diff', '--name-status', base], { cwd, proxy }) }
  catch { return readChangesVsHead(cwd, proxy) }   // base ref unusable → degrade to status
  const stat = parseNumstat(await git(['diff', '--numstat', base], { cwd, proxy }).catch(() => ''))

  const items: ChangeItem[] = []
  const seen = new Set<string>()
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const parts = line.split('\t')
    const code = parts[0][0]
    const path = parts[parts.length - 1]   // for R/C the new path is the last field
    const type: ChangeType = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M'
    const ns = stat.get(path)
    items.push({ path, type, add: ns?.add ?? 0, del: ns?.del ?? 0 })
    seen.add(path)
  }

  // Untracked files created this session — but EXCLUDE any that already exist in the base tree (an
  // original file that's merely untracked, e.g. an unborn/broken worktree, is NOT a session change).
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], { cwd, proxy }).catch(() => ''))
    .split('\n').filter(Boolean)
  if (untracked.length) {
    const baseFiles = new Set((await git(['ls-tree', '-r', '--name-only', base], { cwd, proxy }).catch(() => ''))
      .split('\n').filter(Boolean))
    for (const path of untracked) {
      if (baseFiles.has(path) || seen.has(path)) continue
      items.push({ path, type: 'A', add: countLines(cwd, path), del: 0 })
    }
  }
  return items.sort((a, b) => a.path.localeCompare(b.path))
}

// Fallback for repos with no upstream (plain repos / legacy worktrees): working tree vs HEAD.
async function readChangesVsHead(cwd: string, proxy: string): Promise<ChangeItem[]> {
  let status: string
  try { status = await git(['status', '--porcelain'], { cwd, proxy }) } catch { return [] }
  const lines = status.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return []

  const stat = parseNumstat(await git(['diff', '--numstat', 'HEAD'], { cwd, proxy }).catch(() => ''))
  const items: ChangeItem[] = []
  for (const line of lines) {
    const x = line[0], y = line[1]
    const path = line.slice(3)
    let type: ChangeType
    if (x === '?' && y === '?') type = 'A'
    else if (x === 'A') type = 'A'
    else if (x === 'D' || y === 'D') type = 'D'
    else type = 'M'
    let add = 0, del = 0
    const ns = stat.get(path)
    if (ns) { add = ns.add; del = ns.del }
    else if (type === 'A') add = countLines(cwd, path)
    items.push({ path, type, add, del })
  }
  return items.sort((a, b) => a.path.localeCompare(b.path))
}

export async function readChanges(cwd: string, proxy = ''): Promise<ChangeItem[]> {
  // Diff against the pull baseline so ORIGINAL pulled files never show. Base preference:
  //  1. the branch's own upstream (set at worktree creation on new workspaces), else
  //  2. the repo's default remote branch origin/HEAD — so EXISTING worktrees (created before
  //     upstream-tracking) still get the baseline treatment instead of listing every original file
  //     as 新建.
  // Only when neither resolves (a plain non-remote repo) do we degrade to working-tree-vs-HEAD status.
  let base = ''
  try { base = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd, proxy })).trim() } catch { base = '' }
  if (!base) { try { base = (await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd, proxy })).trim() } catch { base = '' } }
  return base ? readChangesVsBase(cwd, base, proxy) : readChangesVsHead(cwd, proxy)
}

// Aggregate git changes across multiple project cwds. A cwd whose git call throws
// (non-git / missing dir) is skipped — it contributes an empty list, not an error.
// Return shape is flat + serializable for crossing the IPC / ChatMessage boundary.
// (MultiChanges lives in @shared/types so main and renderer agree.)
export async function readChangesMulti(cwds: string[], proxy = ''): Promise<MultiChanges> {
  const byProject = await Promise.all(
    cwds.map(async cwd => ({ cwd, changes: await readChanges(cwd, proxy).catch(() => [] as ChangeItem[]) }))
  )
  const all = byProject.flatMap(p => p.changes)
  return {
    total: all.length,
    add: all.reduce((n, c) => n + c.add, 0),
    del: all.reduce((n, c) => n + c.del, 0),
    byProject,
  }
}
