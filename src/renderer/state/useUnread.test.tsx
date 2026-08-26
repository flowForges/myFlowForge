import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUnread } from './useUnread'
import { isSessionUnread } from '@shared/chat/unread'
import type { ChatEvent } from '@shared/types'

// 订阅侧的契约:另一个会话跑完时要留下未读标记,自己正在看的那个不留。纯 mark/clear 逻辑在 unread.test.ts
// 里已有覆盖,这里补的是「事件真的接到了、viewing 真的是当前值」这一段 —— 之前没有任何测试。

let fire: (e: ChatEvent) => void = () => {}
// 跨设备未读那条广播的回调,和 fire 同一个套路:装订阅时抓住它,测试里直接喂。
let seenCb: (e: { workspacePath: string; sessionId: string }) => void = () => {}
let markChatSeen = vi.fn()
beforeEach(() => {
  markChatSeen = vi.fn()
  // ★seenCb 必须在这里显式归零。不归零的话它只是「碰巧」干净(靠 RTL 的自动 cleanup 卸载了上一个
  // hook,退订才把它置空)—— 那样一条变异是红是绿就取决于 cleanup 的时序,而不取决于 harness。
  seenCb = () => {}
  const forge = {
    onChatEvent: (cb: (e: ChatEvent) => void) => { fire = cb; return () => { fire = () => {} } },
    onChatSeen: (cb: (e: { workspacePath: string; sessionId: string }) => void) => {
      seenCb = cb
      return () => { seenCb = () => {} }
    },
    markChatSeen,
  }
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

describe('★ 跨设备未读', () => {
  it('★别的设备报「这条看过了」时,本机的未读也要清掉(跨设备未读)', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire(done('/ws', 'B')) })
    expect(isSessionUnread(result.current, '/ws', 'B')).toBe(true)
    // 手机上打开了 /ws#B → 主机广播 chat:seen → 电脑这颗圆点也该灭。
    act(() => { seenCb({ workspacePath: '/ws', sessionId: 'B' }) })
    expect(isSessionUnread(result.current, '/ws', 'B')).toBe(false)
  })

  it('别的设备看的是另一条会话时,本机这条未读不受影响', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire(done('/ws', 'B')) })
    act(() => { seenCb({ workspacePath: '/ws', sessionId: 'C' }) })
    expect(isSessionUnread(result.current, '/ws', 'B')).toBe(true)
  })

  it('别的设备报来一条空 id 的「已读」→ 直接忽略,连 state 都不动(和手机端同一份契约)', () => {
    const { result } = renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    act(() => { fire(done('/ws', 'B')) })
    const before = result.current
    act(() => { seenCb({ workspacePath: '', sessionId: '' }) })
    // 没有守卫的话 clearUnread 会造一个全新的 Set(内容一样、身份不同)→ 白白重渲染每个用未读的组件。
    expect(result.current).toBe(before)
  })

  it('★切到一条会话时要告诉主机(否则手机那头的未读永远不灭)', () => {
    const { rerender } = renderHook(
      ({ v }) => useUnread(v),
      { initialProps: { v: { wsPath: '/ws', sessionId: 'A' } } },
    )
    markChatSeen.mockClear()
    rerender({ v: { wsPath: '/ws', sessionId: 'B' } })
    // ★传出去的是 channel 的载荷形状 {workspacePath,…},不是 Viewing 的 {wsPath,…} —— 两者字段名不同。
    expect(markChatSeen).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 'B' })
  })

  it('★远程老主机拒绝这条上报时必须被接住 —— 否则每切一次会话就是一条 unhandledrejection', () => {
    // 电脑端连远程主机时这条 invoke 走 remote/router.ts:老 daemon 方法表里没有 chat:mark-seen,
    // router 会直接抛「不提供这个功能(chat:mark-seen)」。`void` 不吞 rejection,必须挂 .catch。
    const rejected = Promise.reject(new Error('「远程主机」不提供这个功能(chat:mark-seen)'))
    const catchSpy = vi.spyOn(rejected, 'catch')
    markChatSeen.mockReturnValue(rejected)
    renderHook(() => useUnread({ wsPath: '/ws', sessionId: 'A' }))
    expect(catchSpy).toHaveBeenCalled()
  })

  it('没在看任何会话(首页)时不上报 —— 空 id 广播出去是纯噪音', () => {
    const { rerender } = renderHook(
      ({ v }) => useUnread(v),
      { initialProps: { v: { wsPath: '/ws', sessionId: 'A' } } },
    )
    markChatSeen.mockClear()
    rerender({ v: { wsPath: '', sessionId: '' } })
    expect(markChatSeen).not.toHaveBeenCalled()
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
