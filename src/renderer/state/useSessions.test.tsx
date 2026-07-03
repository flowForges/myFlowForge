import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSessions } from './useSessions'
import type { SessionsFile } from '@shared/types'

const file = (ids: string[], active: string): SessionsFile => ({
  sessions: ids.map(id => ({ id, title: id, mode: 'chat' as const, createdAt: 0 })), activeSessionId: active,
})

let sessCb: ((p: { workspacePath: string; file: SessionsFile }) => void) | null = null

beforeEach(() => {
  sessCb = null
  ;(window as any).forge = {
    sessionList: vi.fn().mockResolvedValue(file(['s1'], 's1')),
    sessionNew: vi.fn().mockResolvedValue(file(['s1', 's2'], 's2')),
    sessionSwitch: vi.fn().mockResolvedValue(file(['s1', 's2'], 's1')),
    sessionClose: vi.fn().mockResolvedValue(file(['s1'], 's1')),
    sessionRename: vi.fn().mockResolvedValue(file(['s1'], 's1')),
    onSessionsChanged: (cb: (p: { workspacePath: string; file: SessionsFile }) => void) => {
      sessCb = cb
      return () => { sessCb = null }
    },
  }
})

describe('useSessions', () => {
  it('loads sessions for a workspace', async () => {
    const { result } = renderHook(() => useSessions('/w'))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.activeSessionId).toBe('s1')
  })
  it('newSession updates active', async () => {
    const { result } = renderHook(() => useSessions('/w'))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    await act(async () => { await result.current.newSession() })
    expect(result.current.activeSessionId).toBe('s2')
    expect(result.current.sessions).toHaveLength(2)
  })
  it('onSessionsChanged updates state when workspacePath matches', async () => {
    const { result } = renderHook(() => useSessions('/ws'))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    const newFile = file(['s1', 's2'], 's2')
    act(() => {
      sessCb!({ workspacePath: '/ws', file: newFile })
    })
    expect(result.current.activeSessionId).toBe('s2')
    expect(result.current.sessions).toHaveLength(2)
  })
  it('onSessionsChanged ignores broadcasts for other workspacePaths', async () => {
    const { result } = renderHook(() => useSessions('/ws'))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    const otherFile = file(['s1', 's2'], 's2')
    act(() => {
      sessCb!({ workspacePath: '/other', file: otherFile })
    })
    // Should remain unchanged
    expect(result.current.activeSessionId).toBe('s1')
    expect(result.current.sessions).toHaveLength(1)
  })
})
