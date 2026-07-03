import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-'))
  process.env.HOME = home
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('archiveWorkspaceLifecycle', () => {
  it('marks archived + unpins', async () => {
    const { registerWorkspace, readWorkspaceRegistry, readSettings, writeSettings } = await import('../config/store')
    const { archiveWorkspaceLifecycle } = await import('../workspace/archiveOps')
    registerWorkspace('a', '/tmp/a')
    writeSettings({ ...readSettings(), pinnedWorkspaces: ['/tmp/a'] })
    archiveWorkspaceLifecycle('/tmp/a')
    const e = readWorkspaceRegistry().find(w => w.path === '/tmp/a')!
    expect(e.archived).toBe(true)
    expect(e.archivedAt).toBeGreaterThan(0)
    expect(readSettings().pinnedWorkspaces).not.toContain('/tmp/a')
  })

  it('works when workspace is not pinned', async () => {
    const { registerWorkspace, readWorkspaceRegistry } = await import('../config/store')
    const { archiveWorkspaceLifecycle } = await import('../workspace/archiveOps')
    registerWorkspace('b', '/tmp/b')
    archiveWorkspaceLifecycle('/tmp/b')
    const e = readWorkspaceRegistry().find(w => w.path === '/tmp/b')!
    expect(e.archived).toBe(true)
    expect(e.archivedAt).toBeGreaterThan(0)
  })
})

describe('restoreWorkspaceLifecycle', () => {
  it('clears archived flag', async () => {
    const { registerWorkspace, readWorkspaceRegistry } = await import('../config/store')
    const { archiveWorkspaceLifecycle, restoreWorkspaceLifecycle } = await import('../workspace/archiveOps')
    registerWorkspace('c', '/tmp/c')
    archiveWorkspaceLifecycle('/tmp/c')
    restoreWorkspaceLifecycle('/tmp/c')
    const e = readWorkspaceRegistry().find(w => w.path === '/tmp/c')!
    expect(e.archived).toBe(false)
    expect(e.archivedAt).toBeNull()
  })
})
