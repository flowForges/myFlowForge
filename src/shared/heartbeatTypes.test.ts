import { describe, it, expect } from 'vitest'
import type { AgentState, AgentRuntime, EngineEvent } from './types'

describe('heartbeat types', () => {
  it('AgentState includes stalled + awaiting', () => {
    const states: AgentState[] = ['wait', 'run', 'stalled', 'awaiting', 'ok', 'err']
    expect(states).toContain('stalled')
    expect(states).toContain('awaiting')
  })
  it('AgentRuntime carries lastBeat', () => {
    const a: AgentRuntime = { id: 'a1', name: 'n', role: 'r', provider: 'claude', model: 'm', state: 'run', logs: [], lastBeat: 123 }
    expect(a.lastBeat).toBe(123)
  })
  it('EngineEvent has agent:stalled and agent:heartbeat branches', () => {
    const stalled: EngineEvent = { type: 'agent:stalled', agentId: 'a1', agentName: '开发代理', wsName: 'ws', silentMs: 90000 }
    const beat: EngineEvent = { type: 'agent:heartbeat', agentId: 'a1', at: 456 }
    expect(stalled.type).toBe('agent:stalled')
    expect(beat.type).toBe('agent:heartbeat')
  })
})
