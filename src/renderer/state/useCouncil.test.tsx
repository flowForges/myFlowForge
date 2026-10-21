import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCouncil } from './useCouncil'
import { flashToast } from '../components/flashToast'

vi.mock('../components/flashToast', () => ({ flashToast: vi.fn() }))
import type { CouncilConfig, CouncilSeat, CouncilState, CouncilStatus } from '@shared/council'

const seat = (id: string, provider = 'codex'): CouncilSeat => ({ id, provider, model: `m-${id}`, label: `${provider} · ${id}` })
const config: CouncilConfig = {
  topic: '怎么设计缓存', attachments: [], seats: [seat('A'), seat('B')], leader: seat('L', 'claude'), mode: { kind: 'rounds', rounds: 2 },
}
const state = (id: string, status: CouncilStatus, over: Partial<CouncilState> = {}): CouncilState => ({
  id, workspacePath: '/ws', sessionId: 's1', status, round: 1, totalRounds: 2, speaking: [], startedAt: 0, elapsedMs: 0, config, ...over,
})

let stateHandler: ((s: CouncilState) => void) | null = null
let forge: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  stateHandler = null
  forge = {
    councilList: vi.fn(async () => [state('c0', 'done')]),
    councilLastConfig: vi.fn(async () => ({ seats: config.seats, leader: config.leader, mode: config.mode })),
    councilProjects: vi.fn(async () => [{ name: 'app', cwd: '/ws/app' }]),
    councilStart: vi.fn(async () => 'c9'),
    councilPause: vi.fn(async () => {}),
    councilResume: vi.fn(async () => {}),
    councilStop: vi.fn(async () => {}),
    councilInterject: vi.fn(async () => {}),
    councilFollowup: vi.fn(async () => {}),
    councilChoose: vi.fn(async () => {}),
  }
  ;(window as any).forge = {
    ...forge,
    onCouncilState: (cb: (s: CouncilState) => void) => { stateHandler = cb; return () => { stateHandler = null } },
  }
})

describe('useCouncil', () => {
  it('loads council:list and the last config on mount', async () => {
    const { result } = renderHook(() => useCouncil('/ws', 's1'))
    await waitFor(() => expect(result.current.states.map(s => s.id)).toEqual(['c0']))
    expect(forge.councilList).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 's1' })
    await waitFor(() => expect(result.current.lastConfig?.leader.id).toBe('L'))
    expect(result.current.active).toBeUndefined()
  })

  it('updates on council:state for its session; active = running/paused/finalizing', async () => {
    const { result } = renderHook(() => useCouncil('/ws', 's1'))
    await waitFor(() => expect(result.current.states).toHaveLength(1))
    act(() => { stateHandler!(state('c1', 'running')) })
    expect(result.current.states.map(s => s.id)).toEqual(['c0', 'c1'])
    expect(result.current.active?.id).toBe('c1')
    act(() => { stateHandler!(state('c1', 'paused', { round: 2 })) })
    expect(result.current.states).toHaveLength(2)
    expect(result.current.active).toMatchObject({ id: 'c1', status: 'paused', round: 2 })
    act(() => { stateHandler!(state('c1', 'finalizing')) })
    expect(result.current.active?.status).toBe('finalizing')
    act(() => { stateHandler!(state('c1', 'done')) })
    expect(result.current.active).toBeUndefined()
  })

  it('active prefers the running council over an older paused one (paused does not hold the session, R9)', async () => {
    const { result } = renderHook(() => useCouncil('/ws', 's1'))
    await waitFor(() => expect(result.current.states).toHaveLength(1))
    act(() => { stateHandler!(state('c1', 'paused')) })
    act(() => { stateHandler!(state('c2', 'running')) })
    expect(result.current.active?.id).toBe('c2')
  })

  it('ignores council:state of another session', async () => {
    const { result } = renderHook(() => useCouncil('/ws', 's1'))
    await waitFor(() => expect(result.current.states).toHaveLength(1))
    act(() => { stateHandler!(state('cx', 'running', { sessionId: 's2' })) })
    act(() => { stateHandler!(state('cy', 'running', { workspacePath: '/other' })) })
    expect(result.current.states.map(s => s.id)).toEqual(['c0'])
    expect(result.current.active).toBeUndefined()
  })

  it('a state event arriving before the list snapshot is not overwritten by it', async () => {
    let resolveList: (s: CouncilState[]) => void = () => {}
    forge.councilList.mockImplementation(() => new Promise<CouncilState[]>(r => { resolveList = r }))
    ;(window as any).forge.councilList = forge.councilList
    const { result } = renderHook(() => useCouncil('/ws', 's1'))
    act(() => { stateHandler!(state('c1', 'paused', { round: 2 })) })
    await act(async () => { resolveList([state('c1', 'running'), state('c0', 'done')]) })
    expect(result.current.states.find(s => s.id === 'c1')).toMatchObject({ status: 'paused', round: 2 })
    expect(result.current.states.map(s => s.id).sort()).toEqual(['c0', 'c1'])
  })

  it('a rejected control call shows a toast and resolves false instead of rejecting', async () => {
    vi.mocked(flashToast).mockClear()
    forge.councilFollowup.mockRejectedValueOnce(new Error("Error invoking remote method 'council:followup': Error: not-done"))
    forge.councilPause.mockRejectedValueOnce(new Error('boom'))
    forge.councilChoose.mockRejectedValueOnce(new Error("Error invoking remote method 'council:followup': Error: busy"))
    const { result } = renderHook(() => useCouncil('/ws', 's1'))
    await expect(result.current.followup('c1', '再说说', 'all')).resolves.toBe(false)
    await expect(result.current.pause('c1')).resolves.toBe(false)
    await expect(result.current.choose('c1', 'x')).resolves.toBe(false)
    await expect(result.current.stop('c1', 'finalize')).resolves.toBe(true)
    expect(flashToast).toHaveBeenNthCalledWith(1, '共商尚未结束')
    expect(flashToast).toHaveBeenNthCalledWith(2, '操作失败')
    expect(flashToast).toHaveBeenNthCalledWith(3, '正在回答上一个追问')
    expect(flashToast).toHaveBeenCalledTimes(3)
  })

  it('controls call the bridge with the council id', async () => {
    const { result } = renderHook(() => useCouncil('/ws', 's1'))
    await act(async () => { await result.current.start(config) })
    expect(forge.councilStart).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 's1', config })
    act(() => {
      result.current.pause('c1')
      result.current.resume('c1')
      result.current.stop('c1', 'finalize')
      result.current.interject('c1', '补充一点')
      result.current.followup('c1', '再说说', 'A')
      result.current.choose('c1', '方案一')
    })
    expect(forge.councilPause).toHaveBeenCalledWith({ councilId: 'c1' })
    expect(forge.councilResume).toHaveBeenCalledWith({ councilId: 'c1' })
    expect(forge.councilStop).toHaveBeenCalledWith({ councilId: 'c1', mode: 'finalize' })
    expect(forge.councilInterject).toHaveBeenCalledWith({ councilId: 'c1', text: '补充一点' })
    expect(forge.councilFollowup).toHaveBeenCalledWith({ councilId: 'c1', question: '再说说', target: 'A' })
    expect(forge.councilChoose).toHaveBeenCalledWith({ councilId: 'c1', candidate: '方案一' })
    await expect(result.current.projects()).resolves.toEqual([{ name: 'app', cwd: '/ws/app' }])
    expect(forge.councilProjects).toHaveBeenCalledWith({ workspacePath: '/ws' })
  })

  it('start remembers the config (minus topic/attachments) as lastConfig and surfaces errors', async () => {
    forge.councilLastConfig.mockResolvedValue(null)
    const { result } = renderHook(() => useCouncil('/ws', 's1'))
    await act(async () => { await result.current.start(config) })
    expect(result.current.lastConfig).toEqual({ seats: config.seats, leader: config.leader, mode: config.mode })
    forge.councilStart.mockRejectedValueOnce(new Error('busy'))
    await expect(result.current.start(config)).rejects.toThrow('busy')
  })

  it('switching session drops the previous session states and reloads', async () => {
    const { result, rerender } = renderHook(({ sid }: { sid: string }) => useCouncil('/ws', sid), { initialProps: { sid: 's1' } })
    await waitFor(() => expect(result.current.states).toHaveLength(1))
    forge.councilList.mockResolvedValueOnce([])
    rerender({ sid: 's2' })
    await waitFor(() => expect(forge.councilList).toHaveBeenLastCalledWith({ workspacePath: '/ws', sessionId: 's2' }))
    await waitFor(() => expect(result.current.states).toEqual([]))
  })
})
