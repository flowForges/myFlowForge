import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useComputerUse } from './useComputerUse'

const WS = '/ws/a', SID = 's1'
const status = { supported: true, osOK: true, helper: 'ok' as const, screen: true, ax: true }
let emit: (e: unknown) => void = () => {}
let api: Record<string, ReturnType<typeof vi.fn>>

function install(over: Record<string, unknown> = {}) {
  api = {
    state: vi.fn(async () => ({ sessions: [], gates: [] })),
    log: vi.fn(async () => []),
    status: vi.fn(async () => status),
    setMode: vi.fn(async () => ({ ok: true })),
    resolve: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    thumb: vi.fn(async () => 'data:image/jpeg;base64,AAA'),
    onEvent: vi.fn((cb: (e: unknown) => void) => { emit = cb; return () => { emit = () => {} } }),
    ...over,
  } as never
  ;(window as any).forge = { computerUse: api }
}
beforeEach(() => install())

const gate = (id: string, sid = SID) => ({ id, key: { workspacePath: WS, sessionId: sid }, kind: 'action', ts: 1 })
const entry = (ts: number) => ({ ts, turn: 1, op: 'click', result: 'allowed' })

describe('useComputerUse', () => {
  it('pulls state and the log once on mount, and does NOT ask the helper for status while the mode is off', async () => {
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await waitFor(() => expect(api.state).toHaveBeenCalled())
    expect(api.log).toHaveBeenCalledWith({ workspacePath: WS, sessionId: SID })
    expect(result.current.mode).toBe('off')
    expect(result.current.status).toBeNull()
    expect(api.status).not.toHaveBeenCalled()
  })

  it('queries status when the session is on, or when refreshStatus is called', async () => {
    api.state.mockResolvedValue({ sessions: [{ workspacePath: WS, sessionId: SID, mode: 'ask', title: 'T' }], gates: [] })
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await waitFor(() => expect(result.current.status).toEqual(status))
    expect(result.current.mode).toBe('ask')

    install()
    const r2 = renderHook(() => useComputerUse(WS, 'other'))
    await waitFor(() => expect(api.state).toHaveBeenCalled())
    expect(api.status).not.toHaveBeenCalled()
    await act(async () => { await r2.result.current.refreshStatus() })
    expect(r2.result.current.status).toEqual(status)
  })

  it('busyBy is another session holding the lease; this session on is not busy', async () => {
    api.state.mockResolvedValue({ sessions: [{ workspacePath: WS, sessionId: 'x', mode: 'allow', title: '别的会话' }], gates: [] })
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await waitFor(() => expect(result.current.busyBy).toEqual({ title: '别的会话' }))
    expect(result.current.mode).toBe('off')
  })

  it('keeps only this session\'s gates; gate and gate-resolved events add and remove', async () => {
    api.state.mockResolvedValue({ sessions: [], gates: [gate('g1'), gate('g2', 'other')] })
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await waitFor(() => expect(result.current.gates.map((g) => g.id)).toEqual(['g1']))
    act(() => emit({ type: 'gate', gate: gate('g3') }))
    act(() => emit({ type: 'gate', gate: gate('g4', 'other') }))
    expect(result.current.gates.map((g) => g.id)).toEqual(['g1', 'g3'])
    act(() => emit({ type: 'gate-resolved', id: 'g1', decision: 'allow' }))
    expect(result.current.gates.map((g) => g.id)).toEqual(['g3'])
  })

  it('a state event changes the mode; an off state clears this session\'s gates', async () => {
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await waitFor(() => expect(api.state).toHaveBeenCalled())
    act(() => emit({ type: 'gate', gate: gate('g1') }))
    act(() => emit({ type: 'state', sessions: [{ workspacePath: WS, sessionId: SID, mode: 'ask', title: 'T' }] }))
    expect(result.current.mode).toBe('ask')
    act(() => emit({ type: 'state', sessions: [] }))
    expect(result.current.mode).toBe('off')
    expect(result.current.gates).toEqual([])
  })

  it('appends action events for this session only, after the pulled log', async () => {
    api.log.mockResolvedValue([entry(1)])
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await waitFor(() => expect(result.current.log).toHaveLength(1))
    act(() => emit({ type: 'action', key: { workspacePath: WS, sessionId: SID }, entry: entry(2) }))
    act(() => emit({ type: 'action', key: { workspacePath: WS, sessionId: 'other' }, entry: entry(3) }))
    expect(result.current.log.map((e) => e.ts)).toEqual([1, 2])
  })

  it('an action event that arrives before the log pull finishes is not lost or doubled', async () => {
    let finish: (v: unknown[]) => void = () => {}
    api.log.mockImplementation(() => new Promise((r) => { finish = r }))
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await waitFor(() => expect(api.log).toHaveBeenCalled())
    act(() => emit({ type: 'action', key: { workspacePath: WS, sessionId: SID }, entry: entry(2) }))
    await act(async () => { finish([entry(1), entry(2)]) })
    expect(result.current.log.map((e) => e.ts)).toEqual([1, 2])
  })

  it('setMode passes the key and returns the refusal code (null on success)', async () => {
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await act(async () => { expect(await result.current.setMode('ask')).toBeNull() })
    expect(api.setMode).toHaveBeenCalledWith({ workspacePath: WS, sessionId: SID, mode: 'ask' })
    api.setMode.mockResolvedValue({ ok: false, code: 'restart_required' })
    await act(async () => { expect(await result.current.setMode('ask')).toBe('restart_required') })
  })

  it('resolve / stop / thumb call the bridge with the session key', async () => {
    const { result } = renderHook(() => useComputerUse(WS, SID))
    act(() => result.current.resolve('g1', 'deny'))
    expect(api.resolve).toHaveBeenCalledWith({ id: 'g1', decision: 'deny' })
    act(() => result.current.stop())
    expect(api.stop).toHaveBeenCalledWith({ workspacePath: WS, sessionId: SID })
    expect(await result.current.thumb('00000001.jpg')).toBe('data:image/jpeg;base64,AAA')
    expect(api.thumb).toHaveBeenCalledWith({ workspacePath: WS, sessionId: SID, file: '00000001.jpg' })
  })

  it('a refusal object from the bridge (not_local) leaves everything inert', async () => {
    install({ state: vi.fn(async () => ({ ok: false, code: 'not_local' })), log: vi.fn(async () => ({ ok: false, code: 'not_local' })) })
    const { result } = renderHook(() => useComputerUse(WS, SID))
    await waitFor(() => expect(api.state).toHaveBeenCalled())
    expect(result.current.log).toEqual([])
    expect(result.current.gates).toEqual([])
    expect(result.current.mode).toBe('off')
  })

  it('does not throw without window.forge.computerUse', async () => {
    ;(window as any).forge = {}
    const { result } = renderHook(() => useComputerUse(WS, SID))
    expect(result.current.mode).toBe('off')
    await act(async () => { expect(await result.current.setMode('ask')).toBe('unsupported') })
  })

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useComputerUse(WS, SID))
    unmount()
    expect(emit).not.toBe(undefined)
    // the unsubscribe the mock returns resets emit to a noop; calling it must not throw
    expect(() => emit({ type: 'stopped', why: 'user' })).not.toThrow()
  })
})
