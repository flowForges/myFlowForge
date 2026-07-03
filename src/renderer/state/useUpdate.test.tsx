import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useUpdate } from './useUpdate'
import type { UpdateEvent } from '@shared/types'

let emit: (e: UpdateEvent) => void
const INFO = { version: '2.4.0', notes: 'n', dmgUrl: 'u', dmgSize: 26214400, dmgName: 'a.dmg' }

beforeEach(() => {
  emit = () => {}
  ;(window as any).forge = {
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: vi.fn(async () => {}),
    startUpdate: vi.fn(async () => {}),
    onUpdateEvent: (cb: (e: UpdateEvent) => void) => { emit = cb; return () => {} },
  }
})

describe('useUpdate', () => {
  it('loads current version on mount', async () => {
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.currentVersion).toBe('1.0.0'))
    expect(result.current.phase).toBe('idle')
  })
  it('goes available when an update event arrives', async () => {
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.currentVersion).toBe('1.0.0'))
    act(() => emit({ type: 'available', info: INFO }))
    expect(result.current.info).toEqual(INFO)
    expect(result.current.phase).toBe('available')
  })
  it('check() sets checking, and a none event shows uptodate', async () => {
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.currentVersion).toBe('1.0.0'))
    act(() => result.current.check())
    expect(result.current.phase).toBe('checking')
    expect((window as any).forge.checkUpdate).toHaveBeenCalled()
    act(() => emit({ type: 'none' }))
    expect(result.current.phase).toBe('uptodate')
  })
  it('start() drives progress then done', async () => {
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.currentVersion).toBe('1.0.0'))
    act(() => emit({ type: 'available', info: INFO }))
    act(() => result.current.start())
    expect(result.current.phase).toBe('downloading')
    act(() => emit({ type: 'progress', stage: '正在下载更新包…', pct: 40 }))
    expect(result.current.progress).toEqual({ stage: '正在下载更新包…', pct: 40 })
    act(() => emit({ type: 'done' }))
    expect(result.current.phase).toBe('done')
  })
})
