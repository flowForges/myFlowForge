import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useHome } from './useHome'
import type { WorkspaceMeta } from '@shared/types'

const wsA: WorkspaceMeta = { name: 'A', path: '/ws/a', projectCount: 1, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' }
const wsB: WorkspaceMeta = { name: 'B', path: '/ws/b', projectCount: 2, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' }

beforeEach(() => {
  ;(window as any).forge = {
    listWorkspaces: vi.fn(async () => [wsA]),
    homeStats: async () => ({}),
    openWorkspaceDir: vi.fn(async () => [wsA, wsB]),
    archiveWorkspace: vi.fn(async () => {}),
    restoreWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => ({ purged: true })),
    onWorkspacesChanged: vi.fn((cb: () => void) => { return () => {} })
  }
})

describe('useHome', () => {
  it('loads workspaces on mount and refreshes on openDir', async () => {
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { await result.current.openDir() })
    expect(result.current.workspaces.map(w => w.path)).toEqual(['/ws/a', '/ws/b'])
  })

  it('archive calls forge.archiveWorkspace and reloads', async () => {
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { await result.current.archive('/ws/a') })
    expect((window as any).forge.archiveWorkspace).toHaveBeenCalledWith('/ws/a')
  })

  it('restore calls forge.restoreWorkspace and reloads', async () => {
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { await result.current.restore('/ws/a') })
    expect((window as any).forge.restoreWorkspace).toHaveBeenCalledWith('/ws/a')
  })

  it('remove calls forge.deleteWorkspace and reloads', async () => {
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { const r = await result.current.remove('/ws/a'); expect(r).toEqual({ purged: true }) })
    expect((window as any).forge.deleteWorkspace).toHaveBeenCalledWith('/ws/a')
  })

  it('onWorkspacesChanged triggers reload', async () => {
    let callback: (() => void) | null = null
    ;(window as any).forge.onWorkspacesChanged = vi.fn((cb: () => void) => { callback = cb; return () => {} })
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    const initialListCall = ((window as any).forge.listWorkspaces as any).mock.calls.length
    await act(async () => { callback?.() })
    await waitFor(() => {
      expect(((window as any).forge.listWorkspaces as any).mock.calls.length).toBeGreaterThan(initialListCall)
    })
  })
})
