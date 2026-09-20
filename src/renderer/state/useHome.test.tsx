import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useHome } from './useHome'
import type { WorkspaceMeta } from '@shared/types'

const wsA: WorkspaceMeta = { name: 'A', path: '/ws/a', projectCount: 1, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' }
const wsB: WorkspaceMeta = { name: 'B', path: '/ws/b', projectCount: 2, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' }

beforeEach(() => {
  ;(window as any).forge = {
    listWorkspaces: vi.fn(async () => [wsA]),
    homeStats: async () => ({}),
    openWorkspaceDir: vi.fn(async () => [wsA, wsB]),
    archiveWorkspace: vi.fn(async () => {}),
    restoreWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => ({ purged: true })),
    onWorkspacesChanged: vi.fn((cb: () => void) => { return () => {} })
  }
})

describe('useHome', () => {
  it('loads workspaces on mount and refreshes on openDir', async () => {
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { await result.current.openDir() })
    expect(result.current.workspaces.map(w => w.path)).toEqual(['/ws/a', '/ws/b'])
  })

  it('archive calls forge.archiveWorkspace and reloads', async () => {
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { await result.current.archive('/ws/a') })
    expect((window as any).forge.archiveWorkspace).toHaveBeenCalledWith('/ws/a')
  })

  it('restore calls forge.restoreWorkspace and reloads', async () => {
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { await result.current.restore('/ws/a') })
    expect((window as any).forge.restoreWorkspace).toHaveBeenCalledWith('/ws/a')
  })

  it('remove calls forge.deleteWorkspace and reloads', async () => {
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { const r = await result.current.remove('/ws/a'); expect(r).toEqual({ purged: true }) })
    expect((window as any).forge.deleteWorkspace).toHaveBeenCalledWith('/ws/a')
  })

  it('onWorkspacesChanged triggers reload', async () => {
    let callback: (() => void) | null = null
    ;(window as any).forge.onWorkspacesChanged = vi.fn((cb: () => void) => { callback = cb; return () => {} })
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    const initialListCall = ((window as any).forge.listWorkspaces as any).mock.calls.length
    await act(async () => { callback?.() })
    await waitFor(() => {
      expect(((window as any).forge.listWorkspaces as any).mock.calls.length).toBeGreaterThan(initialListCall)
    })
  })
})

/**
 * ★★切主机之后工作区列表必须跟着换 —— 用户真机报的:「我现在在另外一台电脑,连着当前电脑,
 *  工作区根本就没有切换」。原来 `reload` 的依赖是空数组、effect 只在挂载时跑一次,
 *  于是切过去之后屏幕上还是上一台的工作区,而侧栏那枚主机徽章已经写着新主机的名字 ——
 *  **本机的数据顶着远程主机的名牌**,比报错危险得多(主进程 `router.ts:102` 守的就是这条,
 *  渲染层从另一头把它破了)。
 */
describe('useHome · 跟着主机走', () => {
  /** 驱动 useHost / useHostReadySeq 用的假 host 状态通道。 */
  function hostChannel() {
    // ★订阅者是**一组**:`useHost` 和 `useHostReadySeq` 各订一次。只留最后一个的话
    //  前者永远收不到推送 —— 而那正是这一组测试要验的东西,桩自己把它屏蔽掉就全绿了。
    const subs = new Set<(s: any) => void>()
    ;(window as any).forge.onHostStatus = (cb: (s: any) => void) => { subs.add(cb); return () => { subs.delete(cb) } }
    ;(window as any).forge.hostsStatus = async () => ({ hostId: null, label: '本机', state: { status: 'local' } })
    const push = (s: any) => { for (const cb of subs) cb(s) }
    return {
      connect: (id: string, label: string) => push({ hostId: id, label, state: { status: 'connecting', attempt: 1 } }),
      ready: (id: string, label: string) => push({ hostId: id, label, state: { status: 'ready', methods: new Set() } }),
      local: () => push({ hostId: null, label: '本机', state: { status: 'local' } }),
    }
  }

  it('切到另一台主机:立刻清空上一台的列表,并重新拉那台的', async () => {
    const ch = hostChannel()
    const remote: WorkspaceMeta = { ...wsB, name: '远程', path: '/remote/ws' }
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces.map(w => w.path)).toEqual(['/ws/a']))

    ;(window as any).forge.listWorkspaces = vi.fn(async () => [remote])
    await act(async () => { ch.connect('h1', '那台') })

    await waitFor(() => expect(result.current.workspaces.map(w => w.path)).toEqual(['/remote/ws']))
  })

  it('还没拉回来的那一刻,列表是空的 + loading —— 绝不留着上一台的', async () => {
    const ch = hostChannel()
    let release: (v: WorkspaceMeta[]) => void = () => {}
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    ;(window as any).forge.listWorkspaces = vi.fn(() => new Promise<WorkspaceMeta[]>(res => { release = res }))
    await act(async () => { ch.connect('h1', '那台') })

    expect(result.current.workspaces).toEqual([])
    expect(result.current.loading).toBe(true)
    await act(async () => { release([wsB]) })
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('拉不到那台的列表:报错,而不是显示成「这台机器没有工作区」', async () => {
    const ch = hostChannel()
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    ;(window as any).forge.listWorkspaces = vi.fn(async () => { throw new Error('连接不可用') })
    await act(async () => { ch.connect('h1', '那台') })

    await waitFor(() => expect(result.current.error).toBe('连接不可用'))
    expect(result.current.workspaces).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('重连成功(状态再次变 ready)也要重拉 —— 断线期间那边可能已经变了', async () => {
    const ch = hostChannel()
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { ch.connect('h1', '那台') })
    await waitFor(() => expect(result.current.loading).toBe(false))

    const before = ((window as any).forge.listWorkspaces as any).mock.calls.length
    await act(async () => { ch.ready('h1', '那台') })
    await waitFor(() => {
      expect(((window as any).forge.listWorkspaces as any).mock.calls.length).toBeGreaterThan(before)
    })
  })

  it('切回本机同样要重拉', async () => {
    const ch = hostChannel()
    const { result } = renderHook(() => useHome())
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    await act(async () => { ch.connect('h1', '那台') })
    await waitFor(() => expect(result.current.loading).toBe(false))

    const before = ((window as any).forge.listWorkspaces as any).mock.calls.length
    await act(async () => { ch.local() })
    await waitFor(() => {
      expect(((window as any).forge.listWorkspaces as any).mock.calls.length).toBeGreaterThan(before)
    })
  })
})
