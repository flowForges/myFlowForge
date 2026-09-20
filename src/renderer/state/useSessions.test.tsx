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
  /**
   * ★★★2026-09-20 用户原话:「我在 windows 或者本机,不管点哪个会话,另外一个也跟着跳过去,
   * 这种正常么」。别的设备切会话时,主机那份 activeSessionId 会变并广播给所有人 ——
   * **列表要跟上,选中项不许动**。
   */
  it('★别的设备切了会话:列表跟上,但我这台的选中项纹丝不动', async () => {
    const { result } = renderHook(() => useSessions('/ws'))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.activeSessionId).toBe('s1')

    // 另一台设备切到了 s2(它切完主机就广播这份 file)
    act(() => { sessCb!({ workspacePath: '/ws', file: file(['s1', 's2'], 's2') }) })

    expect(result.current.sessions).toHaveLength(2)     // 新会话出现在列表里
    expect(result.current.activeSessionId).toBe('s1')   // 但我还在看我那个
  })

  it('★我自己点切换:跟着走,并记在这台设备上', async () => {
    const onPick = vi.fn()
    const { result } = renderHook(() => useSessions('/ws', { onPick }))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    ;(window as any).forge.sessionSwitch = vi.fn().mockResolvedValue(file(['s1', 's2'], 's2'))
    await act(async () => { await result.current.switchSession('s2') })

    expect(result.current.activeSessionId).toBe('s2')
    expect(onPick).toHaveBeenCalledWith('/ws', 's2')
    // 主机那份照旧要写 —— 机器人那条路和「新设备第一次进来看哪个」还认它
    expect((window as any).forge.sessionSwitch).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 's2' })
  })

  it('★这台设备记住的选择优先于主机那份 activeSessionId', async () => {
    ;(window as any).forge.sessionList = vi.fn().mockResolvedValue(file(['s1', 's2'], 's1'))
    const { result } = renderHook(() => useSessions('/ws', { remembered: 's2' }))
    await waitFor(() => expect(result.current.sessions).toHaveLength(2))
    expect(result.current.activeSessionId).toBe('s2')
  })

  /**
   * ★宠物气泡的「去 app 处理」是**为某道具体的门**弹的 —— 它必须把界面带到那道门所在的会话。
   *  以前它靠广播把界面带过去;选中项归设备之后广播故意不再动选中项,所以这条路改成
   *  「直接写这台设备的选择」(App 里 onNavigateWorkspace → rememberPick)。
   *  这里钉的是 hook 这一端:remembered 变了就得跟过去,否则门还是看不见。
   */
  it('★remembered 变了(宠物气泡带我去某道门)就跟过去', async () => {
    ;(window as any).forge.sessionList = vi.fn().mockResolvedValue(file(['s1', 's2'], 's1'))
    const { result, rerender } = renderHook(
      ({ r }: { r?: string }) => useSessions('/ws', { remembered: r }),
      { initialProps: { r: undefined as string | undefined } },
    )
    await waitFor(() => expect(result.current.activeSessionId).toBe('s1'))

    rerender({ r: 's2' })
    await waitFor(() => expect(result.current.activeSessionId).toBe('s2'))
  })

  it('★我记住的那个已经不在了就回落,不能指着一个不存在的 id(右边会一片空白)', async () => {
    ;(window as any).forge.sessionList = vi.fn().mockResolvedValue(file(['s1'], 's1'))
    const { result } = renderHook(() => useSessions('/ws', { remembered: '被别人关掉的' }))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.activeSessionId).toBe('s1')
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
