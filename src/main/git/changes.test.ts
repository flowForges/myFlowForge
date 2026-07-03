import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './gitRunner'
import { readChanges } from './changes'

let repo: string
async function commitAll(msg: string) {
  await git(['add', '-A'], { cwd: repo })
  await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', msg], { cwd: repo })
}
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'chg-'))
  await git(['init', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'keep.txt'), 'a\nb\nc\n')
  writeFileSync(join(repo, 'mod.txt'), 'a\nb\nc\n')
  await commitAll('init')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('readChanges', () => {
  it('reports added (untracked), modified, and deleted with A/M/D + line counts', async () => {
    writeFileSync(join(repo, 'new.txt'), 'x\ny\n')              // untracked -> A
    writeFileSync(join(repo, 'mod.txt'), 'a\nB\nc\nd\n')        // modified -> M
    rmSync(join(repo, 'keep.txt'))                             // deleted -> D
    const changes = await readChanges(repo)
    const byPath = Object.fromEntries(changes.map(c => [c.path, c]))
    expect(byPath['new.txt'].type).toBe('A')
    expect(byPath['new.txt'].add).toBe(2)
    expect(byPath['mod.txt'].type).toBe('M')
    expect(byPath['mod.txt'].add).toBeGreaterThan(0)
    expect(byPath['keep.txt'].type).toBe('D')
  })
  it('returns [] for a non-git directory', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nogit-'))
    expect(await readChanges(tmp)).toEqual([])
    rmSync(tmp, { recursive: true, force: true })
  })
})
