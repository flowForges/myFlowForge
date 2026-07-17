import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useRun2 } from './useRun2'

function installForge(overrides: any = {}) {
  let updateCb: any, eventCb: any
  const run2 = {
    getState: vi.fn(async (_ws: string) => ({ machine: { plan: { runId: 'r', stages: [] }, stages: [], currentIndex: 0 }, inbox: [], feedback: [], outcomes: {}, status: 'running', pendingDirective: {} })),
    resolveGate: vi.fn(), resolveLane: vi.fn(), addFeedback: vi.fn(), editFeedback: vi.fn(), removeFeedback: vi.fn(), abort: vi.fn(),
    onEvent: vi.fn((cb: any) => { eventCb = cb; return () => {} }),
    onUpdate: vi.fn((cb: any) => { updateCb = cb; return () => {} }),
    ...overrides,
  }
  ;(window as any).forge = { run2 }
  return { run2, fire: { update: (p: any) => updateCb(p), event: (p: any) => eventCb(p) } }
}

describe('useRun2', () => {
  beforeEach(() => { delete (window as any).forge })

  it('loads initial state via getState and updates on matching run2:update', async () => {
    const { fire } = installForge()
    const { result } = renderHook(() => useRun2('/ws'))
    await waitFor(() => expect(result.current.state?.status).toBe('running'))
    act(() => fire.update({ workspacePath: '/ws', state: { machine: { plan: { runId: 'r', stages: [] }, stages: [], currentIndex: 0 }, inbox: [], feedback: [], outcomes: {}, status: 'awaiting', pendingDirective: {} } }))
    await waitFor(() => expect(result.current.state?.status).toBe('awaiting'))
  })

  it('ignores updates for a different workspace', async () => {
    const { fire } = installForge()
    const { result } = renderHook(() => useRun2('/ws'))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => fire.update({ workspacePath: '/other', state: { status: 'failed' } as any }))
    expect(result.current.state?.status).toBe('running') // unchanged
  })

  it('forwards actions to window.forge.run2 with the workspacePath', async () => {
    const { run2 } = installForge()
    const { result } = renderHook(() => useRun2('/ws'))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => result.current.resolveGate('g1', { type: 'advance' } as any))
    expect(run2.resolveGate).toHaveBeenCalledWith({ workspacePath: '/ws', eventId: 'g1', decision: { type: 'advance' } })
    act(() => result.current.resolveLane('l1', { type: 'skip' } as any))
    expect(run2.resolveLane).toHaveBeenCalledWith({ workspacePath: '/ws', eventId: 'l1', decision: { type: 'skip' } })
    act(() => result.current.addFeedback('hello'))
    expect(run2.addFeedback).toHaveBeenCalledWith({ workspacePath: '/ws', text: 'hello' })
    act(() => result.current.editFeedback('f1', 'edited'))
    expect(run2.editFeedback).toHaveBeenCalledWith({ workspacePath: '/ws', id: 'f1', text: 'edited' })
    act(() => result.current.removeFeedback('f1'))
    expect(run2.removeFeedback).toHaveBeenCalledWith({ workspacePath: '/ws', id: 'f1' })
    act(() => result.current.abort())
    expect(run2.abort).toHaveBeenCalledWith({ workspacePath: '/ws' })
  })

  it('is a safe no-op when window.forge.run2 is absent', () => {
    const { result } = renderHook(() => useRun2('/ws'))
    expect(result.current.state).toBeNull()
    expect(() => result.current.abort()).not.toThrow()
  })

  it('is a safe no-op when workspacePath is undefined', () => {
    installForge()
    const { result } = renderHook(() => useRun2(undefined))
    expect(result.current.state).toBeNull()
    expect(() => result.current.abort()).not.toThrow()
  })
})
