import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './gitRunner'
import { readChanges, readBranch } from './changes'
import { readDiff } from './diff'
import { readTree } from '../fs/fileTree'
import { ensureMirror, addWorktree } from './worktree'

let repo: string
async function commitAll(msg: string) {
  await git(['add', '-A'], { cwd: repo })
  await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', msg], { cwd: repo })
}
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'e2e-'))
  await git(['init', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'a.ts'), 'const x = 1\n')
  await commitAll('init')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('2c read pipeline e2e', () => {
  it('readChanges + readDiff + readTree reflect a real edit', async () => {
    writeFileSync(join(repo, 'a.ts'), 'const x = 2\nconst y = 3\n')
    const changes = await readChanges(repo)
    expect(changes.find(c => c.path === 'a.ts')?.type).toBe('M')
    const diff = await readDiff(repo, 'a.ts')
    expect(diff.some(l => l.kind === 'add' && l.text.includes('y = 3'))).toBe(true)
    const tree = await readTree(repo, changes)
    expect(tree.some(n => n.name === 'a.ts' && n.chg === 'M')).toBe(true)
  })
})

// 「本次会话变更」 must be relative to the pull baseline: a freshly-pulled worktree shows NOTHING
// (original files are not "新建"); only session add/edit/delete show. Exercises the real mirror +
// worktree provisioning (which sets the branch upstream to origin/<base>).
describe('readChanges vs pull baseline (worktree upstream)', () => {
  let root: string, origin: string
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'chg-base-'))
    origin = join(root, 'origin')
    await git(['init', '-b', 'main', origin], { cwd: root })
    writeFileSync(join(origin, 'README.md'), '# proj\n')
    writeFileSync(join(origin, 'app.ts'), 'export const a = 1\n')
    await git(['add', '-A'], { cwd: origin })
    await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: origin })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a freshly-pulled worktree reports NO changes (original files are not shown as 新建)', async () => {
    const mirror = join(root, 'mirror', 'p.git'), wt = join(root, 'ws', 'p')
    await ensureMirror({ mirror, repoUrl: origin })
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/x', baseBranch: 'main' })
    expect(await readChanges(wt)).toEqual([])
  })

  it('shows only session changes (add/edit/delete), not the pulled originals', async () => {
    const mirror = join(root, 'mirror', 'p.git'), wt = join(root, 'ws', 'p')
    await ensureMirror({ mirror, repoUrl: origin })
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/x', baseBranch: 'main' })
    writeFileSync(join(wt, 'app.ts'), 'export const a = 2\n')   // edit → M
    writeFileSync(join(wt, 'NOTES.md'), 'hi\n')                 // new → A
    rmSync(join(wt, 'README.md'))                               // delete → D
    const byPath = Object.fromEntries((await readChanges(wt)).map(c => [c.path, c.type]))
    expect(byPath).toEqual({ 'app.ts': 'M', 'NOTES.md': 'A', 'README.md': 'D' })
  })

  it('readBranch returns the baseline branch (main) for a provisioned worktree', async () => {
    const mirror = join(root, 'mirror', 'p.git'), wt = join(root, 'ws', 'p')
    await ensureMirror({ mirror, repoUrl: origin })
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/x', baseBranch: 'main' })
    expect(await readBranch(wt)).toBe('main')
    expect(await readBranch(join(root, 'nope'))).toBe('')   // non-git → ''
  })

  it('an existing worktree with NO upstream still baselines against origin/HEAD (not all-new)', async () => {
    const mirror = join(root, 'mirror', 'p.git'), wt = join(root, 'ws', 'p')
    await ensureMirror({ mirror, repoUrl: origin })
    await addWorktree({ mirror, worktreePath: wt, branch: 'forge/x', baseBranch: 'main' })
    // Simulate a legacy worktree that never had its upstream set.
    await git(['branch', '--unset-upstream'], { cwd: wt }).catch(() => {})
    expect(await readChanges(wt)).toEqual([])   // origin/HEAD fallback → original files not shown
    writeFileSync(join(wt, 'app.ts'), 'export const a = 9\n')
    expect((await readChanges(wt)).map(c => `${c.type}:${c.path}`)).toEqual(['M:app.ts'])
  })
})
