import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './gitRunner'
import { readChanges } from './changes'
import { readDiff } from './diff'
import { readTree } from '../fs/fileTree'

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
