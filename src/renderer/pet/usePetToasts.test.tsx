import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePetToasts } from './usePetToasts'
import type { EngineEvent, Pet, RunState } from '@shared/types'

let emit: (e: EngineEvent) => void
beforeEach(() => {
  emit = () => {}
  ;(window as any).forge = {
    onEngineEvent: (cb: (e: EngineEvent) => void) => { emit = cb; return () => {} }
  }
})

const ALL: Pet['notify'] = { confirm: true, input: true, done: true }
const confirmEvt: EngineEvent = { type: 'pending:add', action: { id: 'p1', kind: 'confirm', agentId: 'a', agentName: 'D', wsName: 'ds', title: '覆盖 theme.ts', where: 'theme.ts' } }
const okRun = (id: string): RunState => ({ id, workspaceName: 'ds', workspacePath: '/ds', status: 'ok', projects: [], stages: [], pending: [] })

describe('usePetToasts', () => {
  it('adds a confirm toast on pending:add when notify.confirm is true', () => {
    const { result } = renderHook(() => usePetToasts(ALL))
    act(() => emit(confirmEvt))
    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0]).toMatchObject({ id: 'p1', kind: 'confirm', wsName: 'ds', title: '覆盖 theme.ts' })
  })

  it('ignores pending:add when that notify kind is off', () => {
    const { result } = renderHook(() => usePetToasts({ confirm: false, input: true, done: true }))
    act(() => emit(confirmEvt))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('dismisses a toast on pending:resolve (after the 260ms leave)', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => usePetToasts(ALL))
      act(() => emit(confirmEvt))
      act(() => emit({ type: 'pending:resolve', id: 'p1' }))
      expect(result.current.toasts[0].leaving).toBe(true)
      act(() => { vi.advanceTimersByTime(260) })
      expect(result.current.toasts).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  it('auto-dismisses after 7s', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => usePetToasts(ALL))
      act(() => emit(confirmEvt))
      act(() => { vi.advanceTimersByTime(7000) })
      act(() => { vi.advanceTimersByTime(260) })
      expect(result.current.toasts).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  it('adds a done toast on run:update ok and dedupes per run id', () => {
    const { result } = renderHook(() => usePetToasts(ALL))
    act(() => emit({ type: 'run:update', run: okRun('r1') }))
    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0]).toMatchObject({ id: 'done-r1', kind: 'done', wsName: 'ds', title: '任务完成' })
    act(() => emit({ type: 'run:update', run: okRun('r1') }))
    expect(result.current.toasts).toHaveLength(1)
  })

  it('does not add a done toast when notify.done is off', () => {
    const { result } = renderHook(() => usePetToasts({ confirm: true, input: true, done: false }))
    act(() => emit({ type: 'run:update', run: okRun('r1') }))
    expect(result.current.toasts).toHaveLength(0)
  })
})
