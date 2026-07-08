import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { git } from './gitRunner'

export const deriveBranch = (workspaceId: string) => `forge/${workspaceId}`

async function refExists(mirror: string, name: string): Promise<boolean> {
  try { await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: mirror }); return true }
  catch { return false }
}

// Pick the branch a new worktree should fork from. The project's configured default branch may be
// wrong (e.g. user typed "master" but the repo only has "main"), which would make `git worktree add`
// fail. So: use `wanted` if it exists in the mirror; otherwise fall back to the repo's REAL default —
// `clone --bare` points the bare repo's HEAD at origin's default branch, so `symbolic-ref HEAD`
// gives it. Only throw (readable error) when neither resolves — e.g. a truly empty repo.
export async function resolveBaseBranch(mirror: string, wanted: string): Promise<string> {
  const w = (wanted ?? '').trim()
  if (w && await refExists(mirror, w)) return w
  let head = ''
  try { head = (await git(['symbolic-ref', '--short', 'HEAD'], { cwd: mirror })).trim() } catch { head = '' }
  if (head && await refExists(mirror, head)) return head
  throw new Error(`无法确定基线分支:仓库中既无 "${w || wanted}" 也无可用的默认 HEAD 分支`)
}

// Per-mirror serialization so fetch/gc/worktree mutations never race.
const locks = new Map<string, Promise<unknown>>()
function withMirrorLock<T>(mirror: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(mirror) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(mirror, next.catch(() => {}))
  return next
}

export async function ensureMirror(opts: { mirror: string; repoUrl: string; proxy?: string }) {
  return withMirrorLock(opts.mirror, async () => {
    if (existsSync(opts.mirror)) {
      await git(['fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: opts.mirror, proxy: opts.proxy })
      return
    }
    mkdirSync(dirname(opts.mirror), { recursive: true })
    await git(['clone', '--bare', opts.repoUrl, opts.mirror], { cwd: dirname(opts.mirror), proxy: opts.proxy })
  })
}

// Callers must `ensureMirror(...)` first — addWorktree assumes the mirror exists and is current.
// `-B` force-creates the branch from baseBranch: on workspace re-open the old branch ref may linger
// (removeWorktree drops the working tree but not the ref), so we reset it to base for a fresh workspace.
// `-B` still refuses if the branch is checked out in another LIVE worktree, preserving that safety guard.
export async function addWorktree(opts: { mirror: string; worktreePath: string; branch: string; baseBranch: string }) {
  return withMirrorLock(opts.mirror, async () => {
    mkdirSync(dirname(opts.worktreePath), { recursive: true })
    // Idempotent re-provision: a prior attempt may have left stale worktree admin (a failed pull, or a
    // partial/leftover dir). ORDER MATTERS — remove the dir FIRST, THEN prune. `git worktree prune` only
    // drops an admin entry whose working dir is MISSING; if we prune while the dir still exists it's a
    // no-op, and the later `rm` then leaves a "missing but already registered" entry that makes
    // `worktree add` fail with `is a missing but already registered worktree` / `'<branch>' is already
    // used by worktree at '<path>'` (exactly the retry-after-failed-pull error). Removing the dir before
    // pruning makes the stale entry prunable. `--expire=now` forces immediate pruning regardless of any
    // gc.worktreePruneExpire grace period.
    if (existsSync(opts.worktreePath)) rmSync(opts.worktreePath, { recursive: true, force: true })
    await git(['worktree', 'prune', '--expire=now'], { cwd: opts.mirror }).catch(() => {})
    await git(['worktree', 'add', '-B', opts.branch, opts.worktreePath, opts.baseBranch], { cwd: opts.mirror })
  })
}

export async function removeWorktree(opts: { mirror: string; worktreePath: string }) {
  return withMirrorLock(opts.mirror, async () => {
    await git(['worktree', 'remove', '--force', opts.worktreePath], { cwd: opts.mirror })
  })
}
