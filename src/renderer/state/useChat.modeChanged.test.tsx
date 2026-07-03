import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ChatEvent } from '@shared/types'
import { useChat } from './useChat'

let emit: (e: ChatEvent) => void = () => {}

beforeEach(() => {
  ;(window as any).forge = {
    chatHistory: vi.fn().mockResolvedValue([]),
    onChatQueueEvent: () => () => {},
    onChatEvent: (cb: (e: ChatEvent) => void) => { emit = cb; return () => {} },
    sendChat: vi.fn(), chatResolve: vi.fn(), chatCancelQueued: vi.fn(), chatClearQueue: vi.fn(),
  }
})

describe('useChat mode-changed', () => {
  it('invokes onModeChanged for matching workspace + session', () => {
    const onModeChanged = vi.fn()
    renderHook(() => useChat('/w', 's-1', onModeChanged))
    act(() => { emit({ workspacePath: '/w', sessionId: 's-1', type: 'mode-changed', mode: 'workflow', runId: 'run-7' } as ChatEvent) })
    expect(onModeChanged).toHaveBeenCalledWith('workflow', 'run-7')
  })
  it('ignores mode-changed for a different workspace', () => {
    const onModeChanged = vi.fn()
    renderHook(() => useChat('/w', 's-1', onModeChanged))
    act(() => { emit({ workspacePath: '/other', sessionId: 's-1', type: 'mode-changed', mode: 'workflow' } as ChatEvent) })
    expect(onModeChanged).not.toHaveBeenCalled()
  })

  it('merges context updates from streaming think events into the active assistant message', () => {
    const { result } = renderHook(() => useChat('/w', 's-1'))
    act(() => {
      emit({
        workspacePath: '/w',
        sessionId: 's-1',
        type: 'assistant-start',
        id: 'a1',
        model: 'Codex · default',
        context: { skills: [{ name: 'forge-workflow', path: '.claude/skills/forge-workflow/SKILL.md' }], rules: [] },
      } as ChatEvent)
    })
    act(() => {
      emit({
        workspacePath: '/w',
        sessionId: 's-1',
        type: 'think-delta',
        id: 'a1',
        text: '调用 shell',
        context: { skills: [{ name: 'using-superpowers', path: '/Users/zghua/.codex/skills/using-superpowers/SKILL.md', state: 'ok' }], rules: [] },
      } as ChatEvent)
    })

    expect(result.current.messages[0].context?.skills.map(s => s.name)).toEqual(['forge-workflow', 'using-superpowers'])
  })
})
