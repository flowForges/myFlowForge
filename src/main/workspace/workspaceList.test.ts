import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
vi.mock('../config/paths', async (orig) => {
  const actual = await orig<typeof import('../config/paths')>()
  return { ...actual, sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'wsl-')); (globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function writeWsJson(wsPath: string, ws: any) {
  mkdirSync(join(wsPath, '.forge'), { recursive: true })
  writeFileSync(join(wsPath, '.forge', 'workspace.json'), JSON.stringify(ws))
}

describe('listWorkspaces', () => {
  it('returns meta for registered workspaces, skipping ones whose workspace.json is gone', async () => {
    const { registerWorkspace } = await import('../config/store')
    const { listWorkspaces } = await import('./workspaceList')
    const wsA = join(tmp, 'a')
    writeWsJson(wsA, { name: 'A', path: wsA, projects: [{ repoId: 'p1', branch: 'b' }, { repoId: 'p2', branch: 'b' }], workflowId: 'standard', status: 'idle' })
    registerWorkspace('A', wsA)
    registerWorkspace('Gone', join(tmp, 'gone'))
    const list = listWorkspaces()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({ name: 'A', path: wsA, projectCount: 2, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: expect.any(Number), description: '' })
  })

  it('marks pinned workspaces and orders them first, in pin order', async () => {
    const { registerWorkspace } = await import('../config/store')
    const { listWorkspaces } = await import('./workspaceList')
    const a = join(tmp, 'a'), b = join(tmp, 'b'), c = join(tmp, 'c')
    for (const [n, p] of [['A', a], ['B', b], ['C', c]] as const) {
      writeWsJson(p, { name: n, path: p, projects: [], workflowId: 'standard', status: 'idle' })
      registerWorkspace(n, p)
    }
    // pin C then A → they lead, in that order; B (unpinned) follows
    const list = listWorkspaces(undefined, [c, a])
    expect(list.map(w => w.name)).toEqual(['C', 'A', 'B'])
    expect(list.map(w => w.pinned)).toEqual([true, true, false])
  })

  it('orders non-pinned workspaces by the manual workspaceOrder, pinned still first', async () => {
    const { registerWorkspace } = await import('../config/store')
    const { listWorkspaces } = await import('./workspaceList')
    const a = join(tmp, 'a'), b = join(tmp, 'b'), c = join(tmp, 'c'), d = join(tmp, 'd')
    for (const [n, p] of [['A', a], ['B', b], ['C', c], ['D', d]] as const) {
      writeWsJson(p, { name: n, path: p, projects: [], workflowId: 'standard', status: 'idle' })
      registerWorkspace(n, p)
    }
    // pin A (leads). Manual order for the rest: D, B, C — overriding registry order (B, C, D).
    const list = listWorkspaces(undefined, [a], [d, b, c])
    expect(list.map(w => w.name)).toEqual(['A', 'D', 'B', 'C'])
  })

  it('appends workspaces missing from workspaceOrder after ordered ones, keeping registry order', async () => {
    const { registerWorkspace } = await import('../config/store')
    const { listWorkspaces } = await import('./workspaceList')
    const a = join(tmp, 'a'), b = join(tmp, 'b'), c = join(tmp, 'c')
    for (const [n, p] of [['A', a], ['B', b], ['C', c]] as const) {
      writeWsJson(p, { name: n, path: p, projects: [], workflowId: 'standard', status: 'idle' })
      registerWorkspace(n, p)
    }
    // Only C is in the order list → C leads; A and B (unordered) follow in registry order.
    const list = listWorkspaces(undefined, [], [c])
    expect(list.map(w => w.name)).toEqual(['C', 'A', 'B'])
  })

  it('normalizes stored run status to err when no liveRunPath is provided', async () => {
    const { registerWorkspace } = await import('../config/store')
    const { listWorkspaces } = await import('./workspaceList')
    const wsA = join(tmp, 'a')
    writeWsJson(wsA, { name: 'A', path: wsA, projects: [], workflowId: 'standard', status: 'run' })
    registerWorkspace('A', wsA)
    const list = listWorkspaces()
    expect(list[0].status).toBe('err')
  })

  it('keeps stored run status as run when liveRunPath matches the workspace path', async () => {
    const { registerWorkspace } = await import('../config/store')
    const { listWorkspaces } = await import('./workspaceList')
    const wsA = join(tmp, 'a')
    writeWsJson(wsA, { name: 'A', path: wsA, projects: [], workflowId: 'standard', status: 'run' })
    registerWorkspace('A', wsA)
    const list = listWorkspaces(wsA)
    expect(list[0].status).toBe('run')
  })

  it('does not change stored ok or idle status regardless of liveRunPath', async () => {
    const { registerWorkspace } = await import('../config/store')
    const { listWorkspaces } = await import('./workspaceList')
    const wsOk = join(tmp, 'ok')
    const wsIdle = join(tmp, 'idle')
    writeWsJson(wsOk, { name: 'Ok', path: wsOk, projects: [], workflowId: 'standard', status: 'ok' })
    writeWsJson(wsIdle, { name: 'Idle', path: wsIdle, projects: [], workflowId: 'standard', status: 'idle' })
    registerWorkspace('Ok', wsOk)
    registerWorkspace('Idle', wsIdle)
    const list = listWorkspaces()
    const okMeta = list.find(w => w.path === wsOk)
    const idleMeta = list.find(w => w.path === wsIdle)
    expect(okMeta?.status).toBe('ok')
    expect(idleMeta?.status).toBe('idle')
  })

  it('synthesizes an imported meta for a registered path present in the imported index', async () => {
    const { registerWorkspace } = await import('../config/store')
    const { upsertSessions } = await import('../sessionImport/importStore')
    const { listWorkspaces } = await import('./workspaceList')
    const dir = join(tmp, 'imported-proj')
    registerWorkspace('imported-proj', dir)
    upsertSessions([{ source: 'claude', externalId: 'x', cwd: dir, title: 't', startedAt: 1, lastTs: 1, messageCount: 1, filePaths: [], hasBody: true }], 1)
    const meta = listWorkspaces().find(w => w.path === dir)
    expect(meta).toMatchObject({ name: 'imported-proj', imported: true, projectCount: 0, status: 'idle' })
  })

  it('listWorkspaces surfaces archived + createdAt + description', async () => {
    const { registerWorkspace, setWorkspaceLifecycle, writeWorkspace } = await import('../config/store')
    const { listWorkspaces } = await import('./workspaceList')
    const wsPath = join(tmp, 'lifecycle-ws')
    writeWorkspace({ name: 'lifecycle-ws', path: wsPath, workflowId: 'wf', stages: [], projects: [], status: 'idle', plugins: [], stepPlugins: [] })
    registerWorkspace('lifecycle-ws', wsPath)
    setWorkspaceLifecycle(wsPath, { archived: true, archivedAt: 42, description: '核心目标' })
    const metas = listWorkspaces()
    const m = metas.find(x => x.path === wsPath)!
    expect(m.archived).toBe(true)
    expect(m.archivedAt).toBe(42)
    expect(m.description).toBe('核心目标')
  })
})
