import { it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useChat } from './useChat'
import type { ChatEvent, ChatMessage } from '@shared/types'

let handler: ((e: ChatEvent) => void) | null = null
let queueHandler: ((e: any) => void) | null = null
const history: ChatMessage[] = [{ id: 'h1', who: 'user', text: 'old', ts: '0' }]
const emptyQ = (extra: Record<string, unknown> = {}) => ({ workspacePath: '/ws', busy: false, queue: [], running: null, runningTurns: [], runningSessionId: null, runningSessionIds: [], ...extra })
let snapshot: any
beforeEach(() => {
  handler = null; queueHandler = null; snapshot = emptyQ()
  ;(window as any).forge = {
    chatHistory: vi.fn(async () => history),
    chatQueueState: vi.fn(async () => snapshot),
    chatGateState: vi.fn(async () => ({ confirms: [], asks: [] })),
    sendChat: vi.fn(async () => ({})),
    onChatEvent: (cb: (e: ChatEvent) => void) => { handler = cb; return () => { handler = null } },
    onChatQueueEvent: (cb: (e: any) => void) => { queueHandler = cb; return () => { queueHandler = null } },
    chatRetryBlocked: vi.fn(async () => {}),
  }
})

it('external turns caught up from the official app are appended once', async () => {
  const { result } = renderHook(() => useChat('/ws', 's1'))
  await waitFor(() => expect(result.current.messages).toHaveLength(1))
  const ext: ChatMessage[] = [{ id: 'ext-u', who: 'user', text: 'App 问', ts: '1', ext: { app: 'Codex', id: 'u' } }]
  act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'external', messages: ext }) })
  act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'external', messages: ext }) })
  await waitFor(() => expect(result.current.messages.map(m => m.id)).toEqual(['h1', 'ext-u']))
})

it('busy_elsewhere shows the block (and withdraws the dropped bubbles); the queue state clears it; 重试 calls main', async () => {
  const { result } = renderHook(() => useChat('/ws', 's1'))
  await waitFor(() => expect(result.current.messages).toHaveLength(1))
  act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'user', message: { id: 'u1', who: 'user', text: 'x', ts: '1' } }) })
  act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'busy_elsewhere', app: 'Codex', drop: ['u1'] }) })
  await waitFor(() => expect(result.current.blockedApp).toBe('Codex'))
  expect(result.current.messages.map(m => m.id)).toEqual(['h1'])
  act(() => { result.current.retryBlocked() })
  expect((window as any).forge.chatRetryBlocked).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 's1' })
  act(() => { queueHandler!(emptyQ({ blocked: {} })) })
  await waitFor(() => expect(result.current.blockedApp).toBeNull())
  act(() => { queueHandler!(emptyQ({ blocked: { s2: 'Claude' } })) })
  expect(result.current.blockedApp).toBeNull()
})

it('a blocked lane is restored from the queue snapshot when the view mounts', async () => {
  snapshot = emptyQ({ blocked: { s1: 'myFlowForge' } })
  const { result } = renderHook(() => useChat('/ws', 's1'))
  await waitFor(() => expect(result.current.blockedApp).toBe('myFlowForge'))
})
