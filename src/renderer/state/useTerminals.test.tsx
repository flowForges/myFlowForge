import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTerminals } from './useTerminals'

let cwdCb: ((p:{termId:string;cwd:string})=>void) | null = null
beforeEach(() => {
  cwdCb = null
  ;(window as any).forge = {
    termCreate: vi.fn(async () => ({ ok: true })),
    termKill: vi.fn(),
    onTermCwd: (cb:any) => { cwdCb = cb; return () => {} },
    onTermExit: () => () => {},
  }
})

describe('useTerminals', () => {
  it('newTab creates a pty tab and selects it; closeTab kills + removes', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    await act(async () => { result.current.newTab() })
    expect((window as any).forge.termCreate).toHaveBeenCalled()
    expect(result.current.tabs).toHaveLength(1)
    const id = result.current.tabs[0].id
    expect(result.current.activeId).toBe(id)
    await act(async () => { result.current.closeTab(id) })
    expect((window as any).forge.termKill).toHaveBeenCalledWith(id)
    expect(result.current.tabs).toHaveLength(0)
  })
  it('onTermCwd updates the tab cwd + title', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    await act(async () => { result.current.newTab() })
    const id = result.current.tabs[0].id
    act(() => { cwdCb!({ termId: id, cwd: '~/proj' }) })
    expect(result.current.tabs[0].cwd).toBe('~/proj')
  })

  it('openForWorkspace creates a tab rooted at the workspace cwd', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    await act(async () => { result.current.openForWorkspace('/ws/a') })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.tabs[0].cwd).toBe('/ws/a')
    expect((window as any).forge.termCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/ws/a' }))
  })

  it('openForWorkspace reuses the existing tab for the same workspace (no new tab)', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    await act(async () => { result.current.openForWorkspace('/ws/a') })
    const firstId = result.current.tabs[0].id
    // navigate away then back: opening again for the same ws must NOT spawn a 2nd tab
    await act(async () => { result.current.openForWorkspace('/ws/a') })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeId).toBe(firstId)
    expect((window as any).forge.termCreate).toHaveBeenCalledTimes(1)
  })

  it('openForWorkspace opens a fresh tab when the workspace differs (re-target)', async () => {
    const { result, rerender } = renderHook(({ ws }) => useTerminals(() => ws), {
      initialProps: { ws: '/ws/a' },
    })
    await act(async () => { result.current.openForWorkspace('/ws/a') })
    rerender({ ws: '/ws/b' })
    await act(async () => { result.current.openForWorkspace('/ws/b') })
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.tabs[1].cwd).toBe('/ws/b')
    expect(result.current.activeId).toBe(result.current.tabs[1].id)
  })

  it('openForWorkspace with no workspace falls back to a single default tab', async () => {
    const { result } = renderHook(() => useTerminals(() => undefined))
    await act(async () => { result.current.openForWorkspace(undefined) })
    expect(result.current.tabs).toHaveLength(1)
    // opening again with no workspace must not keep spawning tabs
    await act(async () => { result.current.openForWorkspace(undefined) })
    expect(result.current.tabs).toHaveLength(1)
  })

  it('标签页按主机分开 —— 切过去看到的是那台的,不是本机的', async () => {
    const { result, rerender } = renderHook(({ h }) => useTerminals(() => '/ws/a', h), {
      initialProps: { h: { key: 'local', seq: 0 } },
    })
    await act(async () => { await result.current.newTab() })
    const localId = result.current.tabs[0].id

    rerender({ h: { key: 'srv', seq: 1 } })
    expect(result.current.tabs).toHaveLength(0)          // 那台机器上还没开过
    await act(async () => { await result.current.newTab() })
    expect(result.current.tabs).toHaveLength(1)
    const srvId = result.current.tabs[0].id
    expect(srvId).not.toBe(localId)

    rerender({ h: { key: 'local', seq: 1 } })
    expect(result.current.tabs.map(t => t.id)).toEqual([localId])
  })

  it('★allTabs 保留所有主机的 —— 否则切回来是一块空屏', async () => {
    // xterm 的回滚缓冲活在组件实例里。切走时把别的主机那些标签卸载掉,
    // 回滚就整个没了:切过去看一眼再切回来,屏幕上什么都不剩。
    const { result, rerender } = renderHook(({ h }) => useTerminals(() => '/ws/a', h), {
      initialProps: { h: { key: 'local', seq: 0 } },
    })
    await act(async () => { await result.current.newTab() })
    rerender({ h: { key: 'srv', seq: 1 } })
    await act(async () => { await result.current.newTab() })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.allTabs).toHaveLength(2)
  })

  it('★切走一台远程主机 → 它的标签页变成「已退出」;本机的不动', async () => {
    // 远程终端跟着那条连接一起死(host 侧在连接关闭时把 pty 收掉)。
    // 不标出来的话,那些标签页看着还能用,敲进去却石沉大海。
    const { result, rerender } = renderHook(({ h }) => useTerminals(() => '/ws/a', h), {
      initialProps: { h: { key: 'local', seq: 0 } },
    })
    await act(async () => { await result.current.newTab() })          // 本机一个
    rerender({ h: { key: 'srv', seq: 1 } })
    await act(async () => { await result.current.newTab() })          // 远程一个
    rerender({ h: { key: 'local', seq: 1 } })

    const byHost = Object.fromEntries(result.current.allTabs.map(t => [t.host, t.exited]))
    expect(byHost).toEqual({ local: false, srv: true })
  })

  it('★断线重连(同一台,seq 变了)→ 那台的标签页同样变成「已退出」', async () => {
    // 重连拿到的是一条**新连接**,老连接上那些 pty 早在关闭时就被收掉了。
    const { result, rerender } = renderHook(({ h }) => useTerminals(() => '/ws/a', h), {
      initialProps: { h: { key: 'srv', seq: 1 } },
    })
    await act(async () => { await result.current.newTab() })
    expect(result.current.tabs[0].exited).toBe(false)
    rerender({ h: { key: 'srv', seq: 2 } })
    expect(result.current.tabs[0].exited).toBe(true)
  })

  it('本机断不了 —— 进程还在,切出去再切回来接着用', async () => {
    const { result, rerender } = renderHook(({ h }) => useTerminals(() => '/ws/a', h), {
      initialProps: { h: { key: 'local', seq: 0 } },
    })
    await act(async () => { await result.current.newTab() })
    rerender({ h: { key: 'local', seq: 9 } })
    expect(result.current.tabs[0].exited).toBe(false)
  })

  it('does not create a 13th tab past the cap of 12', async () => {
    const { result } = renderHook(() => useTerminals(() => '/ws/a'))
    // Create 12 tabs
    for (let i = 0; i < 12; i++) {
      await act(async () => { await result.current.newTab() })
    }
    expect(result.current.tabs).toHaveLength(12)
    expect((window as any).forge.termCreate).toHaveBeenCalledTimes(12)
    // Attempt to create a 13th — should be a no-op
    await act(async () => { await result.current.newTab() })
    expect(result.current.tabs).toHaveLength(12)
    expect((window as any).forge.termCreate).toHaveBeenCalledTimes(12)
  })
})
