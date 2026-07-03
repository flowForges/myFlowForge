import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEngine } from './useEngine'
import type { EngineEvent } from '@shared/types'

let emit: (e: EngineEvent) => void
beforeEach(() => {
  ;(window as any).forge = {
    onEngineEvent: (cb: (e: EngineEvent) => void) => { emit = cb; return () => {} },
    resolve: async () => {}, startRun: async () => {}, getSettings: async () => ({}), setSettings: async () => ({})
  }
})

describe('useEngine', () => {
  it('updates run state on run:update and tracks pending actions', () => {
    const { result } = renderHook(() => useEngine())
    act(() => emit({ type: 'run:update', run: { id: 'r1', workspaceName: 'ws', workspacePath: '/tmp/ws', status: 'run', projects: [], stages: [{ key: 'design', name: '技术方案设计', state: 'run', agents: [] }], pending: [] } }))
    expect(result.current.run?.stages[0].name).toBe('技术方案设计')
    act(() => emit({ type: 'pending:add', action: { id: 'p1', kind: 'confirm', agentId: 'a', agentName: 'D', wsName: 'ws', title: '覆盖 theme.ts' } }))
    expect(result.current.pending).toHaveLength(1)
    act(() => emit({ type: 'pending:resolve', id: 'p1' }))
    expect(result.current.pending).toHaveLength(0)
  })

  it('updates the matching agent lastBeat when a heartbeat event arrives', () => {
    const { result } = renderHook(() => useEngine())
    act(() => emit({
      type: 'run:update',
      run: {
        id: 'r1',
        workspaceName: 'ws',
        workspacePath: '/tmp/ws',
        status: 'run',
        projects: [],
        stages: [{ key: 'develop', name: '代码开发', state: 'run', agents: [{ id: 'a1', name: 'dev', role: '代码开发', provider: 'claude', model: 'opus-4.8', state: 'run', logs: [] }] }],
        pending: [],
      },
    }))
    act(() => emit({ type: 'agent:heartbeat', agentId: 'a1', at: 1234 }))

    expect(result.current.run?.stages[0].agents[0].lastBeat).toBe(1234)
  })
})
