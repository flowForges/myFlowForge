import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
    writeWorkspace({ name: 'ws1', path: wsPath, workflowId: 'wf', stages: [], workflows: [], projects: [], status: 'idle', plugins: [], stepPlugins: [] })
    const res = await deleteWorkspace(wsPath)
    expect(res.purged).toBe(true)
    expect(existsSync(wsPath)).toBe(false)
  })

  it('in-place workspace delete leaves the folder + the user\'s real repo, only tears down .forge', async () => {
    const { registerWorkspace, writeWorkspace } = await import('../config/store')
    const { deleteWorkspace } = await import('./deleteOps')
    const wsPath = join(home, 'ws-inplace')                       // the user's folder-of-repos
    mkdirSync(join(wsPath, 'api', '.git'), { recursive: true })   // an already-existing on-disk repo
    writeFileSync(join(wsPath, 'api', 'src.txt'), 'user code')
    registerWorkspace('ws-inplace', wsPath)
    writeWorkspace({ name: 'ws-inplace', path: wsPath, workflowId: 'wf', stages: [], workflows: [], projects: [{ repoId: 'api', name: 'api', branch: 'b', provider: '', model: '', inPlace: true }], status: 'idle', plugins: [], stepPlugins: [] })
    expect(existsSync(join(wsPath, '.forge'))).toBe(true)

    const res = await deleteWorkspace(wsPath)

    expect(res.purged).toBe(false)                               // folder not fully purged
    expect(existsSync(wsPath)).toBe(true)                        // the user's folder is intact
    expect(existsSync(join(wsPath, 'api'))).toBe(true)           // the user's real repo is intact
    expect(existsSync(join(wsPath, 'api', 'src.txt'))).toBe(true)
    expect(existsSync(join(wsPath, '.forge'))).toBe(false)       // Forge's own state torn down
  })

  it('mixed workspace delete removes the cloned project dir but keeps the folder + in-place repo', async () => {
    const { registerWorkspace, writeWorkspace } = await import('../config/store')
    const { deleteWorkspace } = await import('./deleteOps')
    const wsPath = join(home, 'ws-mixed')
    mkdirSync(join(wsPath, 'api', '.git'), { recursive: true })  // in-place repo
    writeFileSync(join(wsPath, 'api', 'src.txt'), 'user code')
    mkdirSync(join(wsPath, 'web'), { recursive: true })          // a Forge-cloned project
    registerWorkspace('ws-mixed', wsPath)
    writeWorkspace({ name: 'ws-mixed', path: wsPath, workflowId: 'wf', stages: [], workflows: [], projects: [
      { repoId: 'api', name: 'api', branch: 'b', provider: '', model: '', inPlace: true },
      { repoId: 'web', name: 'web', branch: 'b', provider: '', model: '' },
    ], status: 'idle', plugins: [], stepPlugins: [] })

    const res = await deleteWorkspace(wsPath)

    expect(res.purged).toBe(false)
    expect(existsSync(wsPath)).toBe(true)                        // folder kept (has an in-place repo)
    expect(existsSync(join(wsPath, 'api'))).toBe(true)          // in-place repo kept
    expect(existsSync(join(wsPath, 'web'))).toBe(false)         // cloned project dir removed
    expect(existsSync(join(wsPath, '.forge'))).toBe(false)      // Forge state removed
  })
})

describe('discardPartialCreation (wipe a partial creation, keep the parent folder)', () => {
  it('removes worktree dirs + .forge + registry entry but leaves the parent folder and the user\'s own files', async () => {
    const { registerWorkspace, writeWorkspace, readWorkspaceRegistry } = await import('../config/store')
    const { discardPartialCreation } = await import('./deleteOps')
    const wsPath = join(home, 'ws-partial')
    mkdirSync(join(wsPath, 'proj'), { recursive: true })       // a "pulled" project dir
    writeFileSync(join(wsPath, 'keep-me.txt'), 'user file')     // a file the user had in the chosen folder
    registerWorkspace('ws-partial', wsPath)
    writeWorkspace({ name: 'ws-partial', path: wsPath, workflowId: 'wf', stages: [], workflows: [], projects: [{ repoId: 'proj', name: 'proj', branch: 'b', provider: '', model: '' }], status: 'idle', plugins: [], stepPlugins: [] })
    expect(existsSync(join(wsPath, '.forge'))).toBe(true)       // writeWorkspace created it

    await discardPartialCreation(wsPath)

    expect(readWorkspaceRegistry().find(w => w.path === wsPath)).toBeUndefined()  // off the list
    expect(existsSync(wsPath)).toBe(true)                     // parent folder kept
    expect(existsSync(join(wsPath, 'proj'))).toBe(false)      // worktree dir removed
    expect(existsSync(join(wsPath, '.forge'))).toBe(false)    // .forge state removed
    expect(existsSync(join(wsPath, 'keep-me.txt'))).toBe(true) // user's own file untouched
  })

  it('never deletes an in-place project\'s real repo dir, but still removes .forge + registry entry', async () => {
    const { registerWorkspace, writeWorkspace, readWorkspaceRegistry } = await import('../config/store')
    const { discardPartialCreation } = await import('./deleteOps')
    const wsPath = join(home, 'ws-partial-inplace')
    mkdirSync(join(wsPath, 'api', '.git'), { recursive: true })  // the user's pre-existing repo
    writeFileSync(join(wsPath, 'api', 'src.txt'), 'user code')
    registerWorkspace('ws-partial-inplace', wsPath)
    writeWorkspace({ name: 'ws-partial-inplace', path: wsPath, workflowId: 'wf', stages: [], workflows: [], projects: [{ repoId: 'api', name: 'api', branch: 'b', provider: '', model: '', inPlace: true }], status: 'idle', plugins: [], stepPlugins: [] })
    expect(existsSync(join(wsPath, '.forge'))).toBe(true)

    await discardPartialCreation(wsPath)

    expect(readWorkspaceRegistry().find(w => w.path === wsPath)).toBeUndefined()  // off the list
    expect(existsSync(wsPath)).toBe(true)                       // parent folder kept
    expect(existsSync(join(wsPath, 'api'))).toBe(true)          // in-place repo NOT deleted
    expect(existsSync(join(wsPath, 'api', 'src.txt'))).toBe(true)
    expect(existsSync(join(wsPath, '.forge'))).toBe(false)      // .forge state removed
  })
})

describe('removeWorkspaceFromList (list-only, keeps files)', () => {
  it('removes the registry entry but leaves ALL files on disk — even an app-built workspace', async () => {
    const { registerWorkspace, writeWorkspace, readWorkspaceRegistry, readSettings, writeSettings } = await import('../config/store')
    const { removeWorkspaceFromList } = await import('./deleteOps')
    const wsPath = join(home, 'ws-keep')
    mkdirSync(join(wsPath, '.forge'), { recursive: true })
    registerWorkspace('ws-keep', wsPath)
    writeWorkspace({ name: 'ws-keep', path: wsPath, workflowId: 'wf', stages: [], workflows: [], projects: [], status: 'idle', plugins: [], stepPlugins: [] })
    writeSettings({ ...readSettings(), pinnedWorkspaces: [wsPath] })

    removeWorkspaceFromList(wsPath)

    expect(readWorkspaceRegistry().find(w => w.path === wsPath)).toBeUndefined()  // off the list
    expect(existsSync(wsPath)).toBe(true)                                          // files untouched
    expect(existsSync(join(wsPath, '.forge'))).toBe(true)                          // .forge kept too
    expect(readSettings().pinnedWorkspaces).not.toContain(wsPath)                  // unpinned
  })
})
