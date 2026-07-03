import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { git } from './gitRunner'

export const deriveBranch = (workspaceId: string) => `forge/${workspaceId}`

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
    await git(['worktree', 'add', '-B', opts.branch, opts.worktreePath, opts.baseBranch], { cwd: opts.mirror })
  })
}

export async function removeWorktree(opts: { mirror: string; worktreePath: string }) {
  return withMirrorLock(opts.mirror, async () => {
    await git(['worktree', 'remove', '--force', opts.worktreePath], { cwd: opts.mirror })
  })
}
