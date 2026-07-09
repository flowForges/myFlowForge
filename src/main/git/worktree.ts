import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { git } from './gitRunner'

export const deriveBranch = (workspaceId: string) => `forge/${workspaceId}`

// True if `fullRef` (a full ref path, e.g. refs/remotes/origin/main) resolves in the mirror.
async function refExists(mirror: string, fullRef: string): Promise<boolean> {
  try { await git(['rev-parse', '--verify', '--quiet', fullRef], { cwd: mirror }); return true }
  catch { return false }
}

async function symbolicRefShort(mirror: string, ref: string): Promise<string> {
  try { return (await git(['symbolic-ref', '--short', ref], { cwd: mirror })).trim() } catch { return '' }
}

// Pick the branch a new worktree should fork from, returning its PLAIN name (e.g. "main") so callers
// can persist/display it. The project's configured default branch may be wrong (e.g. user typed
// "master" but the repo only has "main"), which would make `git worktree add` fail. So: use `wanted`
// if upstream has it; otherwise fall back to the repo's REAL default. Upstream now lives in the
// remote-tracking namespace refs/remotes/origin/* (see ensureMirror — we no longer mirror origin into
// refs/heads/* because that collides with our forge/* worktree branches). origin/HEAD gives the real
// default; the bare repo's own HEAD (set by `clone --bare` to origin's default) is a further fallback.
// A refs/heads/* fallback covers legacy mirrors created before the remote-tracking migration. Only
// throw (readable error) when nothing resolves — e.g. a truly empty repo.
export async function resolveBaseBranch(mirror: string, wanted: string): Promise<string> {
  const w = (wanted ?? '').trim()
  if (w && await refExists(mirror, `refs/remotes/origin/${w}`)) return w
  let head = (await symbolicRefShort(mirror, 'refs/remotes/origin/HEAD')).replace(/^origin\//, '')
  if (!head) head = await symbolicRefShort(mirror, 'HEAD')
  if (head && await refExists(mirror, `refs/remotes/origin/${head}`)) return head
  // Legacy mirror (pre-migration): upstream still lives in local heads.
  if (w && await refExists(mirror, `refs/heads/${w}`)) return w
  if (head && await refExists(mirror, `refs/heads/${head}`)) return head
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

export async function ensureMirror(opts: { mirror: string; repoUrl: string; proxy?: string; signal?: AbortSignal }) {
  return withMirrorLock(opts.mirror, async () => {
    if (!existsSync(opts.mirror)) {
      mkdirSync(dirname(opts.mirror), { recursive: true })
      await git(['clone', '--bare', opts.repoUrl, opts.mirror], { cwd: dirname(opts.mirror), proxy: opts.proxy, signal: opts.signal })
    }
    // `clone --bare` mirrors origin's heads straight into refs/heads/* (refspec +refs/heads/*:refs/heads/*).
    // That's the SAME namespace our forge/* worktree branches live in, so `fetch --prune` collides with
    // them: if origin also has a forge/* branch (e.g. one we pushed earlier), git refuses to update the
    // local head because it's checked out in a live worktree — "refusing to fetch into branch
    // 'refs/heads/forge/…' checked out at …", exit 128 — which broke continuing a partial create / adding
    // a 2nd workspace on the same repo. Re-point the remote at the STANDARD remote-tracking namespace so
    // upstream refs never touch our local heads; base branches then resolve from refs/remotes/origin/*
    // (resolveBaseBranch) and worktrees fork from origin/<base> (addWorktree). --replace-all collapses any
    // legacy multi-valued fetch config to this single refspec. Idempotent, so it also migrates old mirrors.
    await git(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: opts.mirror })
    await git(['fetch', '--prune', 'origin'], { cwd: opts.mirror, proxy: opts.proxy, signal: opts.signal })
  })
}

// Callers must `ensureMirror(...)` first — addWorktree assumes the mirror exists and is current.
// `-B` force-creates the branch from baseBranch: on workspace re-open the old branch ref may linger
// (removeWorktree drops the working tree but not the ref), so we reset it to base for a fresh workspace.
// `-B` still refuses if the branch is checked out in another LIVE worktree, preserving that safety guard.
export async function addWorktree(opts: { mirror: string; worktreePath: string; branch: string; baseBranch: string; signal?: AbortSignal }) {
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
    // Fork from the up-to-date remote-tracking ref: upstream now lives in refs/remotes/origin/* (see
    // ensureMirror), so the local head refs/heads/<base> is stale/absent. Fall back to the bare name for
    // legacy mirrors that still keep upstream in local heads. `-B` still names the new branch under
    // refs/heads/forge/* and force-resets it to this start point.
    const startPoint = (await refExists(opts.mirror, `refs/remotes/origin/${opts.baseBranch}`)) ? `origin/${opts.baseBranch}` : opts.baseBranch
    await git(['worktree', 'add', '-B', opts.branch, opts.worktreePath, startPoint], { cwd: opts.mirror, signal: opts.signal })
  })
}

export async function removeWorktree(opts: { mirror: string; worktreePath: string }) {
  return withMirrorLock(opts.mirror, async () => {
    await git(['worktree', 'remove', '--force', opts.worktreePath], { cwd: opts.mirror })
  })
}
