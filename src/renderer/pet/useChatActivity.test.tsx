import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatActivity } from './useChatActivity'
import type { ChatEvent } from '@shared/types'

let handler: ((e: ChatEvent) => void) | null = null
beforeEach(() => {
  handler = null
  ;(window as any).forge = { onChatEvent: (cb: (e: ChatEvent) => void) => { handler = cb; return () => {} } }
})

describe('useChatActivity', () => {
  it('is busy between assistant-start and done, and tracks pending confirms', () => {
    const { result } = renderHook(() => useChatActivity())
    expect(result.current).toEqual({ busy: false, confirmPending: false, justDone: false })
    act(() => handler!({ workspacePath: '/a', sessionId: 's1', type: 'assistant-start', id: 'm1', model: 'x' }))
    expect(result.current.busy).toBe(true)
    act(() => handler!({ workspacePath: '/a', sessionId: 's1', type: 'confirm-request', id: 'c1', title: 't' }))
    expect(result.current.confirmPending).toBe(true)
    act(() => handler!({ workspacePath: '/a', sessionId: 's1', type: 'confirm-resolved', id: 'c1' }))
    expect(result.current.confirmPending).toBe(false)
    act(() => handler!({ workspacePath: '/a', sessionId: 's1', type: 'done', message: { id: 'm1', who: 'ai', text: 'x', ts: '0' } }))
    expect(result.current.busy).toBe(false)
    expect(result.current.justDone).toBe(true) // pet flashes a done reaction on chat completion
  })
})
