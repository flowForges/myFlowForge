import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUnread } from './useUnread'
import { isSessionUnread } from './unread'
import type { ChatEvent } from '@shared/types'

// 订阅侧的契约:另一个会话跑完时要留下未读标记,自己正在看的那个不留。纯 mark/clear 逻辑在 unread.test.ts
// 里已有覆盖,这里补的是「事件真的接到了、viewing 真的是当前值」这一段 —— 之前没有任何测试。

let fire: (e: ChatEvent) => void = () => {}
beforeEach(() => {
  const forge = { onChatEvent: (cb: (e: ChatEvent) => void) => { fire = cb; return () => { fire = () => {} } } }
  ;(window as unknown as Record<string, unknown>)['forge'] = forge
})

const done = (workspacePath: string, sessionId: string): ChatEvent =>
  ({ workspacePath, sessionId, type: 'done', message: { id: 'm', who: 'ai', text: '', ts: '' } }) as ChatEvent

describe('useUnread', () => {
  it('★ 别的会话跑完 → 留下未读', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire(done('/ws', 'B')) })
    expect(isSessionUnread(result.current, '/ws', 'B')).toBe(true)
  })

  it('正在看的那个会话跑完 → 不留未读', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire(done('/ws', 'A')) })
    expect(isSessionUnread(result.current, '/ws', 'A')).toBe(false)
  })

  it('别的工作区跑完 → 也留下未读', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire(done('/other', 'X')) })
    expect(isSessionUnread(result.current, '/other', 'X')).toBe(true)
  })

  it('★ 切过去看它 → 未读清掉', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useUnread(v),
      { initialProps: { v: { wsPath: '/ws', sessionId: 'A' } } },
    )
    act(() => { fire(done('/ws', 'B')) })
    expect(isSessionUnread(result.current, '/ws', 'B')).toBe(true)
    rerender({ v: { wsPath: '/ws', sessionId: 'B' } })
    expect(isSessionUnread(result.current, '/ws', 'B')).toBe(false)
  })

  it('★ viewing 变化后,订阅回调用的是新的 viewing(不是订阅时那一份)', () => {
    // 订阅是空依赖只装一次的,靠 ref 读当前 viewing。若哪天误把 viewing 闭包进去,这条会红:
    // 切到 B 之后 B 跑完不该再标未读。
    const { result, rerender } = renderHook(
      ({ v }) => useUnread(v),
      { initialProps: { v: { wsPath: '/ws', sessionId: 'A' } } },
    )
    rerender({ v: { wsPath: '/ws', sessionId: 'B' } })
    act(() => { fire(done('/ws', 'B')) })
    expect(isSessionUnread(result.current, '/ws', 'B')).toBe(false)
  })

  it('非 done 事件不标未读', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire({ workspacePath: '/ws', sessionId: 'B', type: 'assistant-delta', id: 'x', text: 'hi' } as unknown as ChatEvent) })
    expect(result.current.size).toBe(0)
  })
})

describe('useUnread —— 订阅缺失时的防御', () => {
  it('onChatEvent 不存在时不炸(旧 preload / 测试环境)', () => {
    ;(window as unknown as Record<string, unknown>)['forge'] = {}
    expect(() => renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))).not.toThrow()
  })
})

describe('★ 以错误收尾的回合也要标未读', () => {
  const err = (workspacePath: string, sessionId: string): ChatEvent =>
    ({ workspacePath, sessionId, type: 'error', id: 'a', error: 'boom' }) as ChatEvent

  it('后台会话跑挂了 → 留下未读(这恰恰是最该提醒的情况)', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire(err('/ws', 'B')) })
    expect(isSessionUnread(result.current, '/ws', 'B')).toBe(true)
  })
  it('正在看的那个会话跑挂了 → 不留未读', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire(err('/ws', 'A')) })
    expect(isSessionUnread(result.current, '/ws', 'A')).toBe(false)
  })
})
