import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatActivity } from './useChatActivity'
import type { ChatEvent } from '@shared/types'

// 宠物气泡的「去 app 处理」要落到**发起这次确认的那个会话**。这里守的就是「位置有没有被记住」——
// 原实现只把门的 id 放进 Set,工作区/会话被丢掉,于是只能回落到当前工作区,点了跳错地方。

let fire: (e: ChatEvent) => void = () => {}
beforeEach(() => {
  ;(window as unknown as Record<string, unknown>)['forge'] = {
    onChatEvent: (cb: (e: ChatEvent) => void) => { fire = cb; return () => { fire = () => {} } },
  }
})

const confirmReq = (id: string, ws: string, sid: string): ChatEvent =>
  ({ workspacePath: ws, sessionId: sid, type: 'confirm-request', id, title: '删库?' }) as ChatEvent
const confirmDone = (id: string, ws: string, sid: string): ChatEvent =>
  ({ workspacePath: ws, sessionId: sid, type: 'confirm-resolved', id }) as ChatEvent

describe('useChatActivity —— 确认门的位置', () => {
  it('★ 记住确认所在的工作区与会话,而不只是「有确认」', () => {
    const { result } = renderHook(() => useChatActivity())
    act(() => { fire(confirmReq('c1', '/ws/bg', 'sess-bg')) })
    expect(result.current.confirmPending).toBe(true)
    expect(result.current.confirmAt).toEqual({ wsPath: '/ws/bg', sessionId: 'sess-bg' })
  })
  it('多个门同时挂着时给最新到达的那个', () => {
    const { result } = renderHook(() => useChatActivity())
    act(() => { fire(confirmReq('c1', '/ws/a', 's1')) })
    act(() => { fire(confirmReq('c2', '/ws/b', 's2')) })
    expect(result.current.confirmAt).toEqual({ wsPath: '/ws/b', sessionId: 's2' })
  })
  it('门被解决后位置也清掉', () => {
    const { result } = renderHook(() => useChatActivity())
    act(() => { fire(confirmReq('c1', '/ws/a', 's1')) })
    act(() => { fire(confirmDone('c1', '/ws/a', 's1')) })
    expect(result.current.confirmPending).toBe(false)
    expect(result.current.confirmAt).toBeNull()
  })
  it('解决其中一个,仍指向剩下的那个', () => {
    const { result } = renderHook(() => useChatActivity())
    act(() => { fire(confirmReq('c1', '/ws/a', 's1')) })
    act(() => { fire(confirmReq('c2', '/ws/b', 's2')) })
    act(() => { fire(confirmDone('c2', '/ws/b', 's2')) })
    expect(result.current.confirmAt).toEqual({ wsPath: '/ws/a', sessionId: 's1' })
  })
  it('没有门时是 null', () => {
    const { result } = renderHook(() => useChatActivity())
    expect(result.current.confirmAt).toBeNull()
  })
})
