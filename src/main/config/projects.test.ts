import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'forge-')); ;(globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('projects store', () => {
  it('writes and reads back the projects list', async () => {
    const { writeProjects, readProjects } = await import('./store')
    writeProjects({ projects: [{ id: 'p1', name: 'P1', repoUrl: 'git@x:y/p1.git', defaultBranch: 'main' }] })
    expect(readProjects().projects).toHaveLength(1)
    expect(readProjects().projects[0].id).toBe('p1')
  })
})
