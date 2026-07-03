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

describe('useChat plans (hard gate)', () => {
  it('surfaces plan-request, resolvePlan() routes to chatResolve, plan-resolved clears it', () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    act(() => {
      handler!({
        workspacePath: '/ws', sessionId: 's1', type: 'plan-request', id: 'pl1',
        approach: '逐文件迁移', task: '重构 tokens',
        stages: [{ name: '开发', agents: 2 }],
      })
    })
    expect(result.current.plans.map(p => p.id)).toEqual(['pl1'])
    expect(result.current.plans[0].approach).toBe('逐文件迁移')

    act(() => { result.current.resolvePlan({ id: 'pl1', decision: 'modify', value: '改方向' }) })
    expect((window as any).forge.chatResolve).toHaveBeenCalledWith({ id: 'pl1', decision: 'modify', value: '改方向', workspacePath: '/ws' })
    // optimistic local removal
    expect(result.current.plans).toHaveLength(0)

    // re-add then clear via broadcast plan-resolved
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'plan-request', id: 'pl2', approach: 'x', stages: [] }) })
    expect(result.current.plans).toHaveLength(1)
    act(() => { handler!({ workspacePath: '/ws', sessionId: 's1', type: 'plan-resolved', id: 'pl2' }) })
    expect(result.current.plans).toHaveLength(0)
  })

  it('ignores plan events for a different workspace', () => {
    const { result } = renderHook(() => useChat('/ws', 's1'))
    act(() => { handler!({ workspacePath: '/other', sessionId: 's1', type: 'plan-request', id: 'x', approach: 'a', stages: [] }) })
    expect(result.current.plans).toHaveLength(0)
  })
})
