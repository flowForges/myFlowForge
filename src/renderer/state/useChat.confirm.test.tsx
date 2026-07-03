import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChat } from './useChat'
import type { ChatEvent } from '@shared/types'

let handler: ((e: ChatEvent) => void) | null = null
beforeEach(() => {
  handler = null
  ;(window as any).forge = {
    chatHistory: vi.fn(async () => []),
    sendChat: vi.fn(async () => ({})),
    onChatEvent: (cb: (e: ChatEvent) => void) => { handler = cb; return () => { handler = null } },
    onChatQueueEvent: () => () => {},
    chatResolve: vi.fn(),
  }
})

describe('useChat confirms', () => {
  it('surfaces confirm-request, clears on confirm-resolved, and resolveConfirm() calls IPC', () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'confirm-request', id: 'c1', title: 'Write x', where: 'x.ts' }) })
    expect(result.current.confirms.map(c => c.id)).toEqual(['c1'])
    act(() => { result.current.resolveConfirm({ id: 'c1', decision: 'allow' }) })
    expect((window as any).forge.chatResolve).toHaveBeenCalledWith({ id: 'c1', decision: 'allow', value: undefined, workspacePath: '/ws' })
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'confirm-resolved', id: 'c1' }) })
    expect(result.current.confirms).toHaveLength(0)
  })
})
