import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLogs } from './useLogs'
import type { EngineEvent, RunState } from '@shared/types'

let emitEngine: (e: EngineEvent) => void

beforeEach(() => {
  ;(window as any).forge = {
    onChatEvent: () => () => {},
    onEngineEvent: (cb: (e: EngineEvent) => void) => { emitEngine = cb; return () => {} },
    onChangesEvent: () => () => {},
  }
})

function runWithAgent(state: RunState['stages'][number]['agents'][number]['state']): RunState {
  return {
    id: 'r1',
    workspaceName: 'ws',
    workspacePath: '/tmp/ws',
    status: 'run',
    projects: [],
    pending: [],
    stages: [{
      key: 'develop',
      name: '开发',
      state: 'run',
      agents: [{ id: 'a1', name: '开发代理', role: '开发', provider: 'claude', model: 'opus-4.8', state, logs: [] }],
    }],
  }
}

describe('useLogs heartbeat lifecycle events', () => {
  it('adds a stalled line from agent:stalled and ignores agent:heartbeat', () => {
    const { result } = renderHook(() => useLogs())

    act(() => emitEngine({ type: 'agent:heartbeat', agentId: 'a1', at: 10 }))
    expect(result.current.logs).toHaveLength(0)

    act(() => emitEngine({ type: 'agent:stalled', agentId: 'a1', agentName: '开发代理', wsName: 'ws', silentMs: 90_000 }))
    expect(result.current.logs.some(l => l.src === '开发代理' && l.text.includes('仍在推理中'))).toBe(true)
  })

  it('adds state lines when run:update transitions to stalled or awaiting', () => {
    const { result } = renderHook(() => useLogs())

    act(() => emitEngine({ type: 'run:update', run: runWithAgent('stalled') }))
    expect(result.current.logs.some(l => l.text === '疑似卡住')).toBe(true)

    act(() => emitEngine({ type: 'run:update', run: runWithAgent('awaiting') }))
    expect(result.current.logs.some(l => l.text === '等待确认')).toBe(true)
  })
})
