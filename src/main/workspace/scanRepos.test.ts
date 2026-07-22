import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRepos } from './scanRepos'
import { git } from '../git/gitRunner'

describe('scanRepos', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scan-repos-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds a top-level repo, a nested repo, and a worktree-style (.git file) repo; skips node_modules and non-repo dirs; does not descend into a found repo', async () => {
    // api: top-level repo, real git init so readBranch works faithfully
    const api = join(dir, 'api')
    await git(['init', '-b', 'main', api], { cwd: dir })
    // a submodule-ish nested .git INSIDE api that must NOT be picked up separately (repo = leaf)
    mkdirSync(join(api, 'vendored', '.git'), { recursive: true })

    // packages/lib: nested repo at depth 2
    const lib = join(dir, 'packages', 'lib')
    await git(['init', '-b', 'develop', lib], { cwd: dir })

    // plain: not a repo, should be recursed into (contributes no repo itself)
    mkdirSync(join(dir, 'plain', 'sub'), { recursive: true })
    writeFileSync(join(dir, 'plain', 'sub', 'f.txt'), 'x')

    // node_modules/pkg/.git — must be SKIPPED entirely
    mkdirSync(join(dir, 'node_modules', 'pkg', '.git'), { recursive: true })

    // wt: worktree-style repo where .git is a FILE, not a dir
    mkdirSync(join(dir, 'wt'), { recursive: true })
    writeFileSync(join(dir, 'wt', '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n')

    const repos = await scanRepos(dir)
    const byName = new Map(repos.map(r => [r.name, r]))

    expect(repos.length).toBe(3)
    expect(byName.has('api')).toBe(true)
    expect(byName.get('api')!.relPath).toBe('api')
    expect(byName.get('api')!.branch).toBe('main')

    expect(byName.has('lib')).toBe(true)
    expect(byName.get('lib')!.relPath).toBe('packages/lib')
    expect(byName.get('lib')!.branch).toBe('develop')

    expect(byName.has('wt')).toBe(true)
    expect(byName.get('wt')!.relPath).toBe('wt')

    // node_modules skipped entirely — no repo named 'pkg'
    expect(byName.has('pkg')).toBe(false)
    // did not descend into api's nested .git — no repo named 'vendored'
    expect(byName.has('vendored')).toBe(false)
  })

  it('dedupes name collisions by suffixing', async () => {
    await git(['init', '-b', 'main', join(dir, 'a', 'shared')], { cwd: dir })
    await git(['init', '-b', 'main', join(dir, 'b', 'shared')], { cwd: dir })

    const repos = await scanRepos(dir)
    const names = repos.map(r => r.name).sort()
    expect(names).toEqual(['shared', 'shared-2'])
  })

  it('returns [] for a non-existent root without throwing', async () => {
    const repos = await scanRepos(join(dir, 'does-not-exist'))
    expect(repos).toEqual([])
  })
})
