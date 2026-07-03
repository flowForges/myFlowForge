import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './gitRunner'
import { readChangesMulti } from './changes'

let a: string, b: string
async function commitAll(repo: string, msg: string) {
  await git(['add', '-A'], { cwd: repo })
  await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', msg], { cwd: repo })
}
async function mkRepo(prefix: string): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  await git(['init', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'mod.txt'), 'a\nb\nc\n')
  await commitAll(repo, 'init')
  return repo
}
beforeEach(async () => { a = await mkRepo('cm-a-'); b = await mkRepo('cm-b-') })
afterEach(() => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }) })

describe('readChangesMulti', () => {
  it('aggregates total/add/del across projects and maps byProject', async () => {
    writeFileSync(join(a, 'new.txt'), 'x\ny\n')             // A in a: +2
    writeFileSync(join(b, 'mod.txt'), 'a\nB\nc\nd\n')        // M in b
    const multi = await readChangesMulti([a, b])
    expect(multi.total).toBe(2)
    expect(multi.add).toBeGreaterThanOrEqual(2)
    expect(multi.del).toBeGreaterThanOrEqual(0)
    const map = Object.fromEntries(multi.byProject.map(p => [p.cwd, p.changes]))
    expect(map[a].map(c => c.path)).toContain('new.txt')
    expect(map[b].map(c => c.path)).toContain('mod.txt')
  })

  it('skips a non-git / missing dir without throwing (contributes 0)', async () => {
    writeFileSync(join(a, 'new.txt'), 'x\ny\n')
    const nogit = mkdtempSync(join(tmpdir(), 'cm-nogit-'))
    const multi = await readChangesMulti([a, nogit, '/this/does/not/exist'])
    expect(multi.total).toBe(1)
    expect(multi.byProject.find(p => p.cwd === nogit)?.changes).toEqual([])
    rmSync(nogit, { recursive: true, force: true })
  })
})
