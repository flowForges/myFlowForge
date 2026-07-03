import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTerminals } from './useTerminals'

let cwdCb: ((p:{termId:string;cwd:string})=>void) | null = null
beforeEach(() => {
  cwdCb = null
  ;(window as any).forge = {
    termCreate: vi.fn(async () => ({ ok: true })),
    termKill: vi.fn(),
    onTermCwd: (cb:any) => { cwdCb = cb; return () => {} },
    onTermExit: () => () => {},
  }
})

describe('useTerminals', () => {
  it('newTab creates a pty tab and selects it; closeTab kills + removes', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    await act(async () => { result.current.newTab() })
    expect((window as any).forge.termCreate).toHaveBeenCalled()
    expect(result.current.tabs).toHaveLength(1)
    const id = result.current.tabs[0].id
    expect(result.current.activeId).toBe(id)
    await act(async () => { result.current.closeTab(id) })
    expect((window as any).forge.termKill).toHaveBeenCalledWith(id)
    expect(result.current.tabs).toHaveLength(0)
  })
  it('onTermCwd updates the tab cwd + title', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    await act(async () => { result.current.newTab() })
    const id = result.current.tabs[0].id
    act(() => { cwdCb!({ termId: id, cwd: '~/proj' }) })
    expect(result.current.tabs[0].cwd).toBe('~/proj')
  })

  it('openForWorkspace creates a tab rooted at the workspace cwd', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    await act(async () => { result.current.openForWorkspace('/ws/a') })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.tabs[0].cwd).toBe('/ws/a')
    expect((window as any).forge.termCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/ws/a' }))
  })

  it('openForWorkspace reuses the existing tab for the same workspace (no new tab)', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    await act(async () => { result.current.openForWorkspace('/ws/a') })
    const firstId = result.current.tabs[0].id
    // navigate away then back: opening again for the same ws must NOT spawn a 2nd tab
    await act(async () => { result.current.openForWorkspace('/ws/a') })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeId).toBe(firstId)
    expect((window as any).forge.termCreate).toHaveBeenCalledTimes(1)
  })

  it('openForWorkspace opens a fresh tab when the workspace differs (re-target)', async () => {
    const { result, rerender } = renderHook(({ ws }) => useTerminals(() => ws), {
      initialProps: { ws: '/ws/a' },
    })
    await act(async () => { result.current.openForWorkspace('/ws/a') })
    rerender({ ws: '/ws/b' })
    await act(async () => { result.current.openForWorkspace('/ws/b') })
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.tabs[1].cwd).toBe('/ws/b')
    expect(result.current.activeId).toBe(result.current.tabs[1].id)
  })

  it('openForWorkspace with no workspace falls back to a single default tab', async () => {
    const { result } = renderHook(() => useTerminals(() => undefined))
    await act(async () => { result.current.openForWorkspace(undefined) })
    expect(result.current.tabs).toHaveLength(1)
    // opening again with no workspace must not keep spawning tabs
    await act(async () => { result.current.openForWorkspace(undefined) })
    expect(result.current.tabs).toHaveLength(1)
  })

  it('does not create a 13th tab past the cap of 12', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    // Create 12 tabs
    for (let i = 0; i < 12; i++) {
      await act(async () => { await result.current.newTab() })
    }
    expect(result.current.tabs).toHaveLength(12)
    expect((window as any).forge.termCreate).toHaveBeenCalledTimes(12)
    // Attempt to create a 13th — should be a no-op
    await act(async () => { await result.current.newTab() })
    expect(result.current.tabs).toHaveLength(12)
    expect((window as any).forge.termCreate).toHaveBeenCalledTimes(12)
  })
})
