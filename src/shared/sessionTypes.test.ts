import { describe, it, expect } from 'vitest'
import type { ChatSession, SessionsFile, ChatSendPayload, ChatEvent } from './types'

describe('session types', () => {
  it('ChatSession shape compiles with mode/runId optional', () => {
    const s: ChatSession = { id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }
    const w: ChatSession = { id: 's-2', title: 'x', mode: 'workflow', createdAt: 1, runId: 'r-1' }
    expect(s.mode).toBe('chat'); expect(w.runId).toBe('r-1')
  })
  it('SessionsFile carries sessions + activeSessionId', () => {
    const f: SessionsFile = { sessions: [{ id: 's-1', title: 'a', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }
    expect(f.activeSessionId).toBe('s-1')
  })
  it('ChatSendPayload requires sessionId; ChatEvent carries sessionId', () => {
    const p: ChatSendPayload = { workspacePath: '/w', sessionId: 's-1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: 'hi', attachments: [] }
    const e: ChatEvent = { workspacePath: '/w', sessionId: 's-1', type: 'plan-resolved', id: 'p-1' }
    expect(p.sessionId).toBe('s-1'); expect(e.sessionId).toBe('s-1')
  })
})
