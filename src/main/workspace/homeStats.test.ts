import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/store', () => ({
  readWorkspaceRegistry: vi.fn(),
  readWorkspace: vi.fn(),
}))
vi.mock('../git/changes', () => ({ readChanges: vi.fn() }))

import { readHomeStats } from './homeStats'
import { readWorkspaceRegistry, readWorkspace } from '../config/store'
import { readChanges } from '../git/changes'

const ws = (over: Record<string, unknown> = {}) => ({
  name: 'w', path: '/ws/a', workflowId: 'standard', status: 'idle',
  projects: [{ repoId: 'r1', name: 'web', branch: 'forge/x' }], stages: [], plugins: [], stepPlugins: [],
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('readHomeStats', () => {
  it('aggregates change kinds (A/M/D → a/e/d), picks a branch, defaults mtime to 0 for a missing config', async () => {
    vi.mocked(readWorkspaceRegistry).mockReturnValue([{ name: 'w', path: '/ws/a', createdAt: 0, archived: false, archivedAt: null, description: '' }])
    vi.mocked(readWorkspace).mockReturnValue(ws() as never)
    vi.mocked(readChanges).mockResolvedValue([
      { path: 'a.ts', type: 'A', add: 5, del: 0 },
      { path: 'b.ts', type: 'M', add: 2, del: 1 },
      { path: 'c.ts', type: 'M', add: 0, del: 0 },
      { path: 'd.ts', type: 'D', add: 0, del: 3 },
    ])
    const out = await readHomeStats()
    expect(out['/ws/a'].changes).toEqual({ a: 1, e: 2, d: 1 })
    expect(out['/ws/a'].branch).toBe('forge/x')
    expect(out['/ws/a'].updatedAt).toBe(0) // /ws/a/.forge/workspace.json does not exist
  })

  it('reads changes from each project worktree (<wsPath>/<name||repoId>)', async () => {
    vi.mocked(readWorkspaceRegistry).mockReturnValue([{ name: 'w', path: '/ws/a', createdAt: 0, archived: false, archivedAt: null, description: '' }])
    vi.mocked(readWorkspace).mockReturnValue(ws({ projects: [{ repoId: 'r1', name: 'web', branch: 'b' }, { repoId: 'api', name: '', branch: 'b' }] }) as never)
    vi.mocked(readChanges).mockResolvedValue([])
    await readHomeStats()
    const calledCwds = vi.mocked(readChanges).mock.calls.map(c => c[0])
    expect(calledCwds).toContain('/ws/a/web')
    expect(calledCwds).toContain('/ws/a/api') // name '' falls back to repoId
  })

  it('skips registry entries whose workspace.json is unreadable, and never throws', async () => {
    vi.mocked(readWorkspaceRegistry).mockReturnValue([{ name: 'gone', path: '/ws/gone', createdAt: 0, archived: false, archivedAt: null, description: '' }])
    vi.mocked(readWorkspace).mockReturnValue(null)
    const out = await readHomeStats()
    expect(out).toEqual({})
  })

  it('falls back to "main" when no project carries a branch', async () => {
    vi.mocked(readWorkspaceRegistry).mockReturnValue([{ name: 'w', path: '/ws/a', createdAt: 0, archived: false, archivedAt: null, description: '' }])
    vi.mocked(readWorkspace).mockReturnValue(ws({ projects: [{ repoId: 'r1', name: 'web', branch: '' }] }) as never)
    vi.mocked(readChanges).mockResolvedValue([])
    const out = await readHomeStats()
    expect(out['/ws/a'].branch).toBe('main')
  })
})
