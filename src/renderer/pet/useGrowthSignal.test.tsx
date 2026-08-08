import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useGrowthSignal, type GrowthSignalView } from './useGrowthSignal'

const SIG = (todayTokens: number): GrowthSignalView & { day: string } =>
  ({ day: '2026-08-07', todayTokens })

let push: ((s: GrowthSignalView) => void) | null
let off: ReturnType<typeof vi.fn>
let growthSignalGet: ReturnType<typeof vi.fn>

beforeEach(() => {
  push = null
  off = vi.fn()
  growthSignalGet = vi.fn(async () => SIG(60000))
  ;(window as any).forge = {
    growthSignalGet,
    onGrowthSignal: (cb: (s: GrowthSignalView) => void) => { push = cb; return off },
  }
})

describe('useGrowthSignal', () => {
  // 宠物窗口可能晚于主窗口启动 —— 干等下一次广播会一直没有画面,所以挂载时必须主动拉一次。
  it('pulls the current signal on mount', async () => {
    const { result } = renderHook(() => useGrowthSignal())
    expect(result.current).toBeNull()
    expect(growthSignalGet).toHaveBeenCalledTimes(1)
  })

  it('updates on every broadcast', async () => {
    const { result } = renderHook(() => useGrowthSignal())
    act(() => push!(SIG(124000)))
    expect(result.current?.todayTokens).toBe(124_000)
    act(() => push!(SIG(1)))
  })

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useGrowthSignal())
    expect(off).not.toHaveBeenCalled()
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  // 旧 preload 没有这两个 IPC:必须安静地回落到 null,让调用方走普通宠物路径,而不是炸掉宠物窗口。
  it('returns null (and never throws) when the preload has no growth IPC', async () => {
    ;(window as any).forge = {}
    const { result, unmount } = renderHook(() => useGrowthSignal())
    expect(result.current).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(result.current).toBeNull()
    expect(() => unmount()).not.toThrow()
  })

  // window.forge 整个不存在(设置页的测试环境就是这样,而这个 hook 现在也被设置页用)。
  // 可选链只加在方法上是不够的 —— `window.forge.x?.()` 在 forge 为 undefined 时照样抛。
  it('returns null (and never throws) when window.forge is missing entirely', async () => {
    delete (window as any).forge
    const { result, unmount } = renderHook(() => useGrowthSignal())
    expect(result.current).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(result.current).toBeNull()
    expect(() => unmount()).not.toThrow()
  })

  it('survives a rejected growthSignalGet and still takes the broadcast', async () => {
    ;(window as any).forge.growthSignalGet = vi.fn(async () => { throw new Error('no handler') })
    const { result } = renderHook(() => useGrowthSignal())
    await act(async () => { await Promise.resolve() })
    expect(result.current).toBeNull()
    act(() => push!(SIG(80000)))
  })

  // 竞态:广播抢在首次 invoke 的 resolve 之前到达时,那次拉取拿到的是更旧的快照,不能回写 ——
  // 否则进度会先倒退一格,直到下一次广播才纠正(肉眼可见的一跳)。
  it('does not let a late-resolving initial pull clobber a broadcast that already landed', async () => {
    let resolvePull: (s: GrowthSignalView) => void = () => {}
    ;(window as any).forge.growthSignalGet = vi.fn(() => new Promise<GrowthSignalView>((res) => { resolvePull = res }))
    const { result } = renderHook(() => useGrowthSignal())
    act(() => push!(SIG(160000)))
    await act(async () => { resolvePull(SIG(20000)); await Promise.resolve() })
  })
})
