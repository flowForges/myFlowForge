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
  it('★切换工作区时立刻丢弃上一个工作区的会话(否则标题会闪一下前一个会话的名字)', async () => {
    // 现场:点了工作区 B 的会话2,但 file 里还是 A 的列表 + A 的 activeSessionId,
    // 于是标题先渲染成 A 的会话1,等 sessionList(B) 回来才纠正 —— 就是用户看到的那一闪。
    const api = (window as any).forge
    api.sessionList = vi.fn().mockResolvedValue(file(['a1', 'a2'], 'a1'))
    const { result, rerender } = renderHook(({ p }: { p: string }) => useSessions(p), { initialProps: { p: '/wsA' } })
    await waitFor(() => expect(result.current.activeSessionId).toBe('a1'))

    // 切到 B:让 B 的请求悬着不 resolve,复现「新数据还没到」的那一帧
    let resolveB: (f: SessionsFile) => void = () => {}
    api.sessionList = vi.fn().mockReturnValue(new Promise<SessionsFile>(res => { resolveB = res }))
    rerender({ p: '/wsB' })
    // 这一帧必须已经不是 A 的数据了
    expect(result.current.sessions).toHaveLength(0)
    expect(result.current.activeSessionId).toBeUndefined()

    await act(async () => { resolveB(file(['b1', 'b2'], 'b2')) })
    expect(result.current.activeSessionId).toBe('b2')
  })

  it('★上一个工作区的迟到响应不能覆盖当前工作区(切换过快时的乱序保护)', async () => {
    const api = (window as any).forge
    let resolveA: (f: SessionsFile) => void = () => {}
    api.sessionList = vi.fn().mockReturnValue(new Promise<SessionsFile>(res => { resolveA = res }))
    const { result, rerender } = renderHook(({ p }: { p: string }) => useSessions(p), { initialProps: { p: '/wsA' } })
    api.sessionList = vi.fn().mockResolvedValue(file(['b1'], 'b1'))
    rerender({ p: '/wsB' })
    await waitFor(() => expect(result.current.activeSessionId).toBe('b1'))
    // A 的响应现在才回来 —— 不能把 B 的数据顶掉
    await act(async () => { resolveA(file(['a1'], 'a1')) })
    expect(result.current.activeSessionId).toBe('b1')
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
