import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useLastRun } from './useLastRun'
import type { RunState } from '@shared/types'

const mkRun = (workspacePath: string, id = 'r'): RunState => ({
  id, workspaceName: 'x', workspacePath, status: 'ok', projects: [], stages: [], pending: [],
})

describe('useLastRun', () => {
  beforeEach(() => {
    ;(window as any).forge = { ...(window as any).forge, lastRun: vi.fn(async (p: string) => mkRun(p, 'disk-' + p)) }
  })

  it('returns the live run when it belongs to the selected workspace (no IPC)', () => {
    const live = mkRun('/ws/a', 'live')
    const { result } = renderHook(() => useLastRun('/ws/a', live))
    expect(result.current).toBe(live)
    expect((window as any).forge.lastRun).not.toHaveBeenCalled()
  })

  it('fetches the disk snapshot when live run is absent or for another workspace', async () => {
    const live = mkRun('/ws/other', 'live')
    const { result } = renderHook(() => useLastRun('/ws/a', live))
    await waitFor(() => expect(result.current?.id).toBe('disk-/ws/a'))
  })

  it('returns null and skips IPC when no workspace selected', () => {
    const { result } = renderHook(() => useLastRun(undefined, null))
    expect(result.current).toBe(null)
    expect((window as any).forge.lastRun).not.toHaveBeenCalled()
  })

  it('discards stale responses when the workspace changes quickly', async () => {
    let resolveA!: (r: RunState | null) => void
    ;(window as any).forge.lastRun = vi.fn((p: string) =>
      p === '/ws/a' ? new Promise<RunState | null>(res => { resolveA = res }) : Promise.resolve(mkRun(p, 'disk-' + p)))
    const { result, rerender } = renderHook(({ ws }) => useLastRun(ws, null), { initialProps: { ws: '/ws/a' } })
    rerender({ ws: '/ws/b' })
    await waitFor(() => expect(result.current?.id).toBe('disk-/ws/b'))
    resolveA(mkRun('/ws/a', 'stale-a'))
    await new Promise(r => setTimeout(r, 0))
    expect(result.current?.id).toBe('disk-/ws/b')   // 旧响应被丢弃
  })
})
