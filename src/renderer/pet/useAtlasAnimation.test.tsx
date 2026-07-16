import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { PetAction } from '@shared/petAtlas'
import { useAtlasAnimation } from './useAtlasAnimation'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useAtlasAnimation', () => {
  it('starts at frame 0 and advances by per-frame duration (idle: 280ms → frame 1)', () => {
    const { result } = renderHook(() => useAtlasAnimation('idle'))
    expect(result.current).toBe(0)
    act(() => { vi.advanceTimersByTime(280) })
    expect(result.current).toBe(1)
    act(() => { vi.advanceTimersByTime(110) })
    expect(result.current).toBe(2)
  })

  it('loops back to 0 after the final frame', () => {
    const { result } = renderHook(() => useAtlasAnimation('idle'))
    // idle has 6 frames; total = 280+110+110+140+140+320
    act(() => { vi.advanceTimersByTime(280 + 110 + 110 + 140 + 140 + 320) })
    expect(result.current).toBe(0)
  })

  it('resets to frame 0 when the action changes', () => {
    const { result, rerender } = renderHook(({ a }: { a: PetAction }) => useAtlasAnimation(a), { initialProps: { a: 'idle' } })
    act(() => { vi.advanceTimersByTime(280) })
    expect(result.current).toBe(1)
    rerender({ a: 'running' })
    expect(result.current).toBe(0)
  })

  it('stays on frame 0 under reduced motion', () => {
    const { result } = renderHook(() => useAtlasAnimation('idle', { reducedMotion: true }))
    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current).toBe(0)
  })
})
