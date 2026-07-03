import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useWorktree } from './useWorktree'
import type { ChangesEvent, ChangeItem, TreeNode } from '@shared/types'

let handler: ((e: ChangesEvent) => void) | null = null
const initial: ChangeItem[] = [{ path: 'a.ts', type: 'M', add: 1, del: 0 }]
const tree: TreeNode[] = [{ type: 'file', name: 'a.ts', path: 'a.ts', chg: 'M' }]

beforeEach(() => {
  handler = null
  ;(window as any).forge = {
    watchChanges: vi.fn(async () => initial),
    watchStop: vi.fn(async () => {}),
    fsTree: vi.fn(async () => tree),
    onChangesEvent: (cb: (e: ChangesEvent) => void) => { handler = cb; return () => { handler = null } }
  }
})

describe('useWorktree', () => {
  it('loads initial changes + tree, and updates on a matching changes event', async () => {
    const { result } = renderHook(() => useWorktree('/w'))
    await waitFor(() => expect(result.current.changes).toHaveLength(1))
    expect(result.current.tree).toHaveLength(1)
    act(() => { handler!({ cwd: '/w', changes: [{ path: 'b.ts', type: 'A', add: 2, del: 0 }] }) })
    await waitFor(() => expect(result.current.changes[0].path).toBe('b.ts'))
    act(() => { handler!({ cwd: '/other', changes: [] }) })
    expect(result.current.changes[0].path).toBe('b.ts')
  })
  it('stops watching when cwd becomes undefined', async () => {
    const { rerender } = renderHook(({ cwd }) => useWorktree(cwd), { initialProps: { cwd: '/w' as string | undefined } })
    await waitFor(() => expect((window as any).forge.watchChanges).toHaveBeenCalled())
    rerender({ cwd: undefined })
    await waitFor(() => expect((window as any).forge.watchStop).toHaveBeenCalled())
  })
})
