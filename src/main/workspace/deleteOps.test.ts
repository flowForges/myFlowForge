import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-'))
  process.env.HOME = home
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('deleteWorkspace', () => {
  it('imported workspace delete removes entry but NOT files', async () => {
    const { registerWorkspace, readWorkspaceRegistry } = await import('../config/store')
    const { deleteWorkspace } = await import('./deleteOps')
    const userRepo = join(home, 'real-repo')
    mkdirSync(userRepo, { recursive: true })
    registerWorkspace('imp', userRepo)        // no workspace.json → imported-style
    const res = await deleteWorkspace(userRepo)
    expect(res.purged).toBe(false)
    expect(existsSync(userRepo)).toBe(true)   // user files untouched
    expect(readWorkspaceRegistry().find(w => w.path === userRepo)).toBeUndefined()
  })

  it('app-built workspace delete purges the dir', async () => {
    const { registerWorkspace, writeWorkspace } = await import('../config/store')
    const { deleteWorkspace } = await import('./deleteOps')
    const wsPath = join(home, 'ws1')
    mkdirSync(wsPath, { recursive: true })
    registerWorkspace('ws1', wsPath)
    writeWorkspace({ name: 'ws1', path: wsPath, workflowId: 'wf', stages: [], projects: [], status: 'idle', plugins: [], stepPlugins: [] })
    const res = await deleteWorkspace(wsPath)
    expect(res.purged).toBe(true)
    expect(existsSync(wsPath)).toBe(false)
  })
})

describe('removeWorkspaceFromList (list-only, keeps files)', () => {
  it('removes the registry entry but leaves ALL files on disk — even an app-built workspace', async () => {
    const { registerWorkspace, writeWorkspace, readWorkspaceRegistry, readSettings, writeSettings } = await import('../config/store')
    const { removeWorkspaceFromList } = await import('./deleteOps')
    const wsPath = join(home, 'ws-keep')
    mkdirSync(join(wsPath, '.forge'), { recursive: true })
    registerWorkspace('ws-keep', wsPath)
    writeWorkspace({ name: 'ws-keep', path: wsPath, workflowId: 'wf', stages: [], projects: [], status: 'idle', plugins: [], stepPlugins: [] })
    writeSettings({ ...readSettings(), pinnedWorkspaces: [wsPath] })

    removeWorkspaceFromList(wsPath)

    expect(readWorkspaceRegistry().find(w => w.path === wsPath)).toBeUndefined()  // off the list
    expect(existsSync(wsPath)).toBe(true)                                          // files untouched
    expect(existsSync(join(wsPath, '.forge'))).toBe(true)                          // .forge kept too
    expect(readSettings().pinnedWorkspaces).not.toContain(wsPath)                  // unpinned
  })
})
