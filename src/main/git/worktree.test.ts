import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './gitRunner'
import { deriveBranch, ensureMirror, addWorktree, removeWorktree } from './worktree'

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
})
