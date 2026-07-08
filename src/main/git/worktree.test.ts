import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './gitRunner'
import { deriveBranch, ensureMirror, addWorktree, removeWorktree, resolveBaseBranch } from './worktree'

let root: string, source: string
async function makeSourceRepo(dir: string) {
  mkdirSync(dir, { recursive: true })
  await git(['init', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# src\n')
  await git(['add', '.'], { cwd: dir })
  await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wt-')); source = join(root, 'source')
  await makeSourceRepo(source)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('worktree manager', () => {
  it('derives a workspace-scoped branch name', () => {
    expect(deriveBranch('wsA')).toBe('forge/wsA')
  })
  it('clones a bare mirror once and adds an isolated worktree on its own branch', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })
    expect(existsSync(join(mirror, 'HEAD'))).toBe(true)

    const wt = join(root, 'wsA', 'proj')
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/wsA', baseBranch: 'main' })
    expect(existsSync(join(wt, 'README.md'))).toBe(true)
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt })
    expect(branch.trim()).toBe('forge/wsA')
  })
  it('two workspaces share one mirror but get independent worktrees/branches', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })
    const a = join(root, 'wsA', 'proj'), b = join(root, 'wsB', 'proj')
    await addWorktree({ mirror, worktreePath: a, branch: 'forge/wsA', baseBranch: 'main' })
    await addWorktree({ mirror, worktreePath: b, branch: 'forge/wsB', baseBranch: 'main' })
    writeFileSync(join(a, 'a.txt'), 'A')
    writeFileSync(join(b, 'b.txt'), 'B')
    expect(existsSync(join(a, 'b.txt'))).toBe(false)
    expect(existsSync(join(b, 'a.txt'))).toBe(false)
  })
  it('isolates commits at the branch level: a commit on one branch is invisible on the other', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })
    const a = join(root, 'wsA', 'proj'), b = join(root, 'wsB', 'proj')
    await addWorktree({ mirror, worktreePath: a, branch: 'forge/wsA', baseBranch: 'main' })
    await addWorktree({ mirror, worktreePath: b, branch: 'forge/wsB', baseBranch: 'main' })
    writeFileSync(join(a, 'only-in-a.txt'), 'A')
    await git(['add', '.'], { cwd: a })
    await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', 'A-only change'], { cwd: a })
    const logA = await git(['log', '--oneline'], { cwd: a })
    const logB = await git(['log', '--oneline'], { cwd: b })
    expect(logA).toContain('A-only change')
    expect(logB).not.toContain('A-only change')
  })
  it('resolveBaseBranch keeps a branch that exists in the mirror', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })
    expect(await resolveBaseBranch(mirror, 'main')).toBe('main')
  })
  it('resolveBaseBranch falls back to the real default HEAD when the wanted branch is missing', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })   // source default is main
    // user typo'd "master" — repo has only main; must self-heal to the real default
    expect(await resolveBaseBranch(mirror, 'master')).toBe('main')
  })
  it('resolveBaseBranch throws a readable error when neither wanted nor HEAD resolves', async () => {
    // an empty bare repo has no commits and an unborn HEAD → nothing to base on
    const empty = join(root, 'empty.git')
    await git(['init', '--bare', '-b', 'main', empty], { cwd: root })
    await expect(resolveBaseBranch(empty, 'master')).rejects.toThrow(/基线分支|base branch/i)
  })
  it('removes a worktree and frees its working files', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })
    const wt = join(root, 'wsA', 'proj')
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/wsA', baseBranch: 'main' })
    await removeWorktree({ mirror, worktreePath: wt })
    expect(existsSync(wt)).toBe(false)
  })
  it('allows re-opening a workspace: add -> remove -> add again with the same branch name', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })
    const wt = join(root, 'wsA', 'proj')
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/wsA', baseBranch: 'main' })
    await removeWorktree({ mirror, worktreePath: wt })
    // must not throw "branch already exists" — the lingering ref is force-reset by addWorktree
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/wsA', baseBranch: 'main' })
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt })
    expect(branch.trim()).toBe('forge/wsA')
  })
  // Retry-after-failed-pull: an interrupted/failed provision leaves the working dir GONE but git still
  // holds the worktree admin entry. Re-adding must recover (prune the stale entry) instead of throwing
  // "is a missing but already registered worktree" / "'forge/wsA' is already used by worktree".
  it('recovers from a stale registration whose working dir vanished (failed pull)', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })
    const wt = join(root, 'wsA', 'proj')
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/wsA', baseBranch: 'main' })
    rmSync(wt, { recursive: true, force: true })   // dir gone, admin entry lingers
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/wsA', baseBranch: 'main' })
    expect(existsSync(join(wt, 'README.md'))).toBe(true)
  })
  // The trickier variant that the old prune-then-rm order mishandled: a PARTIAL dir is still on disk, so
  // an up-front `prune` sees a "live" dir and no-ops; only removing the dir FIRST makes the entry prunable.
  it('re-provisions idempotently when a partial worktree dir is still on disk', async () => {
    const mirror = join(root, 'mirror', 'proj.git')
    await ensureMirror({ mirror, repoUrl: source })
    const wt = join(root, 'wsA', 'proj')
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/wsA', baseBranch: 'main' })
    writeFileSync(join(wt, 'partial.txt'), 'leftover from a failed attempt')
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/wsA', baseBranch: 'main' })
    expect(existsSync(join(wt, 'README.md'))).toBe(true)
    expect(existsSync(join(wt, 'partial.txt'))).toBe(false)   // fresh checkout, leftover cleared
  })
})
