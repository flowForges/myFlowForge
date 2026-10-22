import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useChat } from './useChat'
import { buildTimeline } from '../views/chat/timeline'
import type { ChatEvent, ChatMessage } from '@shared/types'

// B1:历史重拉(切会话 / 重连)会丢掉还没落盘的共商发言;之后的流式事件重建它时必须带上 council 标签,
// 否则它被当成普通消息画在共商区块外面。

let handler: ((e: ChatEvent) => void) | null = null
let history: ChatMessage[] = []
const ev = (e: Record<string, unknown>) => handler!({ workspacePath: '/ws', sessionId: 's1', ...e } as ChatEvent)
const tag = { id: 'c1', seat: 'A', round: 2, stage: 'answer' as const }
const topic: ChatMessage = { id: 'c1:topic', who: 'user', text: '议题', ts: '2026-10-21T09:00:00.000Z', council: { id: 'c1', stage: 'topic' } }

beforeEach(() => {
  handler = null
  history = [topic]
  ;(window as any).forge = {
    chatHistory: vi.fn(async () => history),
    chatQueueState: vi.fn(async () => ({ workspacePath: '/ws', queue: [], runningTurns: [], runningSessionIds: [] })),
    chatGateState: vi.fn(async () => ({ confirms: [], asks: [] })),
    onChatEvent: (cb: (e: ChatEvent) => void) => { handler = cb; return () => { handler = null } },
    onChatQueueEvent: () => () => {},
  }
})

async function mount() {
  const hook = renderHook(() => useChat('/ws', 's1'))
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(1))
  return hook
}

describe('useChat — council tag from streaming events', () => {
  it('deltas after a history reload recreate the reply WITH its council tag and the timeline groups it', async () => {
    const { result } = await mount()
    act(() => {
      ev({ type: 'think-delta', id: 'c1:2:A:answer', text: '想', council: tag })
      ev({ type: 'assistant-delta', id: 'c1:2:A:answer', text: '答', council: tag })
    })
    await waitFor(() => expect(result.current.messages.find(m => m.id === 'c1:2:A:answer')?.text).toBe('答'))
    expect(result.current.messages.find(m => m.id === 'c1:2:A:answer')?.council).toEqual(tag)
    const tl = buildTimeline(result.current.messages, [], [], [])
    expect(tl.map(e => e.kind)).toEqual(['council'])
  })

  it('assistant-replace creating the reply carries the tag', async () => {
    const { result } = await mount()
    act(() => { ev({ type: 'assistant-replace', id: 'c1:2:A:answer', text: '全文', council: tag }) })
    expect(result.current.messages.find(m => m.id === 'c1:2:A:answer')?.council).toEqual(tag)
  })

  it('an existing untagged message gets the tag from a later delta / replace', async () => {
    history = [topic, { id: 'c1:2:A:answer', who: 'ai', text: '前半', ts: '' }]
    const { result } = renderHook(() => useChat('/ws', 's1'))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    act(() => { ev({ type: 'assistant-delta', id: 'c1:2:A:answer', text: '后半', council: tag }) })
    await waitFor(() => expect(result.current.messages.find(m => m.id === 'c1:2:A:answer')?.text).toBe('前半后半'))
    expect(result.current.messages.find(m => m.id === 'c1:2:A:answer')?.council).toEqual(tag)
    const other = { id: 'c1:2:B:answer', who: 'ai' as const, text: 'x', ts: '' }
    act(() => { ev({ type: 'done', message: other }) })
    act(() => { ev({ type: 'assistant-replace', id: 'c1:2:B:answer', text: 'y', council: { ...tag, seat: 'B' } }) })
    expect(result.current.messages.find(m => m.id === 'c1:2:B:answer')?.council).toEqual({ ...tag, seat: 'B' })
  })
})
