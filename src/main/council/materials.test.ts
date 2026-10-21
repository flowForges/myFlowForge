import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config/store', () => ({
  readWorkspace: () => ({ name: 'ws', path: '/w/ws', stages: [], projects: [{ name: 'api', repoId: 'r1' }, { name: '', repoId: 'web' }] }),
}))

import { collectMaterials, listCouncilProjects } from './materials'

let repo: string
let c1: string
let c2: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'council-mat-'))
  git('init', '-q')
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'one\n'); writeFileSync(join(repo, 'b.txt'), 'bee\n')
  git('add', '.'); git('commit', '-qm', 'c1'); c1 = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  git('commit', '-qam', 'c2'); c2 = git('rev-parse', 'HEAD')
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('collectMaterials', () => {
  it('returns empty string when no materials', async () => {
    expect(await collectMaterials(undefined)).toBe('')
    expect(await collectMaterials({})).toBe('')
  })

  it('uncommitted diff includes staged and unstaged changes', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nSTAGED\n'); git('add', 'a.txt')
    writeFileSync(join(repo, 'b.txt'), 'bee\nUNSTAGED\n')
    const t = await collectMaterials({ projectCwd: repo, diff: 'uncommitted' })
    expect(t).toContain('+STAGED')
    expect(t).toContain('+UNSTAGED')
    git('reset', '-q', '--hard', 'HEAD')
  })

  it('range diff between two commits', async () => {
    const t = await collectMaterials({ projectCwd: repo, diff: { range: `${c1}..${c2}` } })
    expect(t).toContain('+two')
  })

  it('over cap returns stat without diff body', async () => {
    const t = await collectMaterials({ projectCwd: repo, diff: { range: `${c1}..${c2}` } }, 100)
    expect(t).toContain('a.txt')
    expect(t).not.toContain('@@')
  })

  it('rejects an invalid range', async () => {
    await expect(collectMaterials({ projectCwd: repo, diff: { range: 'a..b; rm -rf /' } })).rejects.toThrow()
    await expect(collectMaterials({ projectCwd: repo, diff: { range: '--output=x..b' } })).rejects.toThrow()
  })

  it('rejects when not a git repo', async () => {
    const d = mkdtempSync(join(tmpdir(), 'council-nogit-'))
    await expect(collectMaterials({ projectCwd: d, diff: 'uncommitted' })).rejects.toThrow()
    rmSync(d, { recursive: true, force: true })
  })

  it('lists files without inlining contents', async () => {
    const t = await collectMaterials({ files: ['src/x.ts', 'src/y.ts'] })
    expect(t).toContain('src/x.ts')
    expect(t).toContain('src/y.ts')
  })
})

describe('listCouncilProjects', () => {
  it('maps workspace projects to name + cwd', () => {
    expect(listCouncilProjects('/w/ws')).toEqual([
      { name: 'api', cwd: '/w/ws/api' },
      { name: 'web', cwd: '/w/ws/web' },
    ])
  })
})
