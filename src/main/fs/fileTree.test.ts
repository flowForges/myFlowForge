import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTree, readTree } from './fileTree'
import { git } from '../git/gitRunner'
import type { ChangeItem } from '@shared/types'

describe('buildTree', () => {
  it('builds a nested tree from file paths, dirs first then alpha, with change marks', () => {
    const files = ['src/b.ts', 'src/a/x.ts', 'README.md', 'src/a.ts']
    const changes: ChangeItem[] = [{ path: 'src/b.ts', type: 'M', add: 1, del: 0 }]
    const tree = buildTree(files, changes)
    expect(tree.map(n => n.name)).toEqual(['src', 'README.md'])
    const src = tree[0]
    expect(src.type).toBe('dir')
    expect(src.children!.map(n => `${n.type}:${n.name}`)).toEqual(['dir:a', 'file:a.ts', 'file:b.ts'])
    const bts = src.children!.find(n => n.name === 'b.ts')!
    expect(bts.path).toBe('src/b.ts')
    expect(bts.chg).toBe('M')
  })
})

describe('readTree fs fallback (non-git dir, e.g. workspace root)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ftree-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('walks the filesystem when the dir is not a git repo, skipping heavy dirs', async () => {
    mkdirSync(join(dir, 'projA'), { recursive: true })
    writeFileSync(join(dir, 'projA', 'main.go'), 'package main')
    writeFileSync(join(dir, 'README.md'), '# ws')
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '')
    const tree = await readTree(dir)
    const names = tree.map(n => n.name)
    expect(names).toContain('projA')
    expect(names).toContain('README.md')
    expect(names).not.toContain('node_modules')   // skipped
    const projA = tree.find(n => n.name === 'projA')!
    expect(projA.children!.map(n => n.name)).toContain('main.go')
  })
})

describe('readTree shows every project folder (walkDir BFS + dir markers)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ftree-multi-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('shows all sibling project folders, including an empty one and a build-only one', async () => {
    // 5 project folders under a workspace root. Previously a DFS + file cap could drain one big
    // project and never list the others; and folders with no plain files vanished entirely.
    for (const p of ['projA', 'projB', 'projC', 'projD', 'projE']) mkdirSync(join(dir, p), { recursive: true })
    writeFileSync(join(dir, 'projA', 'a.ts'), 'export {}')
    writeFileSync(join(dir, 'projB', 'b.ts'), 'export {}')
    // projC is EMPTY (freshly cloned, nothing checked out yet)
    // projD holds only a skipped build dir → contributes no plain files
    mkdirSync(join(dir, 'projD', 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'projD', 'node_modules', 'x', 'i.js'), '')
    // projE has a nested source file
    mkdirSync(join(dir, 'projE', 'src'), { recursive: true })
    writeFileSync(join(dir, 'projE', 'src', 'main.go'), 'package main')

    const tree = await readTree(dir)
    const names = tree.map(n => n.name)
    expect(names).toEqual(expect.arrayContaining(['projA', 'projB', 'projC', 'projD', 'projE']))
    // build-only project shows as a folder but its skipped dir is not walked
    const projD = tree.find(n => n.name === 'projD')!
    expect(projD.type).toBe('dir')
    expect((projD.children ?? []).some(n => n.name === 'node_modules')).toBe(false)
  })
})

describe('readTree tags git-repo folders with their branch', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ftree-branch-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a subfolder that is a git repo gets node.branch; a plain folder does not', async () => {
    // workspace root (not a repo) with a project subfolder that IS a git repo on branch feat/x
    const proj = join(dir, 'myproj')
    await git(['init', '-b', 'feat/x', proj], { cwd: dir })
    writeFileSync(join(proj, 'a.ts'), 'export {}')
    // a plain (non-git) sibling folder
    mkdirSync(join(dir, 'notes'), { recursive: true })
    writeFileSync(join(dir, 'notes', 'x.md'), '# x')

    const tree = await readTree(dir)
    expect(tree.find(n => n.name === 'myproj')?.branch).toBe('feat/x')
    expect(tree.find(n => n.name === 'notes')?.branch).toBeUndefined()
  })
})

describe('readTree shows dot-dirs (walkDir dot-dir fix)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ftree-dotdir-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('includes dot-dir contents and dot-files, excludes SKIP_DIRS', async () => {
    // dot-dir: .github/workflows/ci.yml
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI')
    // dot-file at root
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    // normal dir + file
    mkdirSync(join(dir, 'normal'), { recursive: true })
    writeFileSync(join(dir, 'normal', 'main.ts'), 'export {}')
    // SKIP_DIRS: node_modules should be excluded
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '')

    const tree = await readTree(dir)
    const names = tree.map(n => n.name)

    // dot-file at root should appear
    expect(names).toContain('.env')
    // .github dir should appear
    expect(names).toContain('.github')
    // .github should contain workflows child
    const github = tree.find(n => n.name === '.github')!
    expect(github).toBeDefined()
    expect(github.children!.map(n => n.name)).toContain('workflows')
    const workflows = github.children!.find(n => n.name === 'workflows')!
    expect(workflows.children!.map(n => n.name)).toContain('ci.yml')
    // normal dir should appear
    expect(names).toContain('normal')
    // node_modules should be excluded
    expect(names).not.toContain('node_modules')
  })
})
