import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useRun2 } from './useRun2'

function installForge(overrides: any = {}) {
  let updateCb: any, eventCb: any, logCb: any, queueCb: any
  const run2 = {
    getState: vi.fn(async (_ws: string) => ({ machine: { plan: { runId: 'r', stages: [] }, stages: [], currentIndex: 0 }, inbox: [], feedback: [], outcomes: {}, status: 'running', pendingDirective: {} })),
    resolveGate: vi.fn(), resolveLane: vi.fn(), addFeedback: vi.fn(), editFeedback: vi.fn(), removeFeedback: vi.fn(), abort: vi.fn(),
    pause: vi.fn(), resume: vi.fn(), jumpBack: vi.fn(),
    onEvent: vi.fn((cb: any) => { eventCb = cb; return () => {} }),
    onUpdate: vi.fn((cb: any) => { updateCb = cb; return () => {} }),
    onLog: vi.fn((cb: any) => { logCb = cb; return () => {} }),
    onQueue: vi.fn((cb: any) => { queueCb = cb; return () => {} }),
    ...overrides,
  }
  ;(window as any).forge = { run2 }
  return { run2, fire: { update: (p: any) => updateCb(p), event: (p: any) => eventCb(p), log: (p: any) => logCb(p), queue: (p: any) => queueCb(p) } }
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
    act(() => result.current.pause())
    expect(run2.pause).toHaveBeenCalledWith({ workspacePath: '/ws' })
    act(() => result.current.resume())
    expect(run2.resume).toHaveBeenCalledWith({ workspacePath: '/ws' })
    act(() => result.current.jumpBack('design'))
    expect(run2.jumpBack).toHaveBeenCalledWith({ workspacePath: '/ws', targetKey: 'design' })
  })

  it('is a safe no-op when window.forge.run2 is absent', () => {
    const { result } = renderHook(() => useRun2('/ws'))
    expect(result.current.state).toBeNull()
    expect(() => result.current.abort()).not.toThrow()
    expect(() => result.current.pause()).not.toThrow()
    expect(() => result.current.resume()).not.toThrow()
    expect(() => result.current.jumpBack('design')).not.toThrow()
  })

  it('is a safe no-op when workspacePath is undefined', () => {
    installForge()
    const { result } = renderHook(() => useRun2(undefined))
    expect(result.current.state).toBeNull()
    expect(() => result.current.abort()).not.toThrow()
    expect(() => result.current.pause()).not.toThrow()
    expect(() => result.current.resume()).not.toThrow()
    expect(() => result.current.jumpBack('design')).not.toThrow()
  })

  it('buffers run2:log lines per lane for the matching workspace, and ignores other workspaces', async () => {
    const { fire } = installForge()
    const { result } = renderHook(() => useRun2('/ws'))
    await waitFor(() => expect(result.current.state).not.toBeNull())

    act(() => fire.log({
      workspacePath: '/ws',
      log: { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '思考A', level: 'run', kind: 'think' } },
    }))
    act(() => fire.log({
      workspacePath: '/ws',
      log: { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '思考B', level: 'run', kind: 'think' } },
    }))
    // A different workspace's log must not land in this hook's buffer.
    act(() => fire.log({
      workspacePath: '/other',
      log: { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '别的工作区', level: 'run', kind: 'think' } },
    }))

    await waitFor(() => expect(result.current.laneLogs['design:root']?.length).toBe(2))
    expect(result.current.laneLogs['design:root'].map((l) => l.line.text)).toEqual(['思考A', '思考B'])
  })

  it('caps a lane\'s buffered log lines at ~40, dropping the oldest', async () => {
    const { fire } = installForge()
    const { result } = renderHook(() => useRun2('/ws'))
    await waitFor(() => expect(result.current.state).not.toBeNull())

    act(() => {
      for (let i = 0; i < 45; i++) {
        fire.log({
          workspacePath: '/ws',
          log: { laneId: 'dev:app', stageKey: 'dev', agentName: 'Codex', line: { ts: '', text: `行${i}`, level: 'run', kind: 'output' } },
        })
      }
    })

    await waitFor(() => expect(result.current.laneLogs['dev:app']?.length).toBe(40))
    expect(result.current.laneLogs['dev:app'][0].line.text).toBe('行5')
    expect(result.current.laneLogs['dev:app'][39].line.text).toBe('行44')
  })

  it('clears laneLogs when a NEW run (different runId) starts in the same workspace', async () => {
    const { fire } = installForge()
    const { result } = renderHook(() => useRun2('/ws'))
    // Initial getState carries runId 'r'.
    await waitFor(() => expect(result.current.state?.machine.plan.runId).toBe('r'))

    act(() => fire.log({
      workspacePath: '/ws',
      log: { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '上一次运行的行', level: 'run', kind: 'think' } },
    }))
    await waitFor(() => expect(result.current.laneLogs['design:root']?.length).toBe(1))

    // A brand-new run in the same ws (new runId) must wipe the previous run's buffered lines.
    act(() => fire.update({
      workspacePath: '/ws',
      state: { machine: { plan: { runId: 'r2', stages: [] }, stages: [], currentIndex: 0 }, inbox: [], feedback: [], outcomes: {}, status: 'running', pendingDirective: {} } as any,
    }))
    await waitFor(() => expect(result.current.state?.machine.plan.runId).toBe('r2'))
    expect(result.current.laneLogs['design:root']).toBeUndefined()

    // New run's logs buffer fresh.
    act(() => fire.log({
      workspacePath: '/ws',
      log: { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '新运行的行', level: 'run', kind: 'think' } },
    }))
    await waitFor(() => expect(result.current.laneLogs['design:root']?.length).toBe(1))
    expect(result.current.laneLogs['design:root'][0].line.text).toBe('新运行的行')
  })

  it('does NOT clear laneLogs on a same-run update (same runId)', async () => {
    const { fire } = installForge()
    const { result } = renderHook(() => useRun2('/ws'))
    await waitFor(() => expect(result.current.state?.machine.plan.runId).toBe('r'))

    act(() => fire.log({
      workspacePath: '/ws',
      log: { laneId: 'design:root', stageKey: 'design', agentName: 'Codex', line: { ts: '', text: '当前运行的行', level: 'run', kind: 'think' } },
    }))
    await waitFor(() => expect(result.current.laneLogs['design:root']?.length).toBe(1))

    // A same-run status update (still runId 'r') must NOT drop the current run's buffered lines.
    act(() => fire.update({
      workspacePath: '/ws',
      state: { machine: { plan: { runId: 'r', stages: [] }, stages: [], currentIndex: 0 }, inbox: [], feedback: [], outcomes: {}, status: 'awaiting', pendingDirective: {} } as any,
    }))
    await waitFor(() => expect(result.current.state?.status).toBe('awaiting'))
    expect(result.current.laneLogs['design:root']?.length).toBe(1)
  })

  // Task 2 (queue): useRun2 surfaces a workspace's pending-queue length from the run2:queue
  // broadcast so RunPanel can show a "队列: N" badge.
  it('defaults queueLength to 0 and updates it from matching run2:queue broadcasts, ignoring other workspaces', async () => {
    const { fire } = installForge()
    const { result } = renderHook(() => useRun2('/ws'))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    expect(result.current.queueLength).toBe(0)

    act(() => fire.queue({ workspacePath: '/ws', length: 3 }))
    await waitFor(() => expect(result.current.queueLength).toBe(3))

    act(() => fire.queue({ workspacePath: '/other', length: 9 }))
    expect(result.current.queueLength).toBe(3) // unchanged
  })
})
