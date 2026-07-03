import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { scaleFromDrag, usePetResize } from './usePetResize'

function move(screenX: number, screenY: number) {
  const ev = new Event('pointermove')
  ;(ev as any).screenX = screenX
  ;(ev as any).screenY = screenY
  return ev
}
const down = (x: number, y: number) => ({ screenX: x, screenY: y, button: 0 })

describe('scaleFromDrag (纯换算)', () => {
  it('零位移返回起始 scale', () => {
    expect(scaleFromDrag(1, 0, 0)).toBe(1)
    expect(scaleFromDrag(1.3, 0, 0)).toBe(1.3)
  })
  it('沿对角拖 88px(dx=dy=88)放大 +1.0', () => {
    expect(scaleFromDrag(0.8, 88, 88)).toBeCloseTo(1.8)
  })
  it('往左上拖缩小,夹在下限 0.6', () => {
    expect(scaleFromDrag(1, -44, -44)).toBe(0.6) // 1 - 0.5 = 0.5 → 夹到 0.6
    expect(scaleFromDrag(1, -8800, -8800)).toBe(0.6)
  })
  it('放大夹在上限 1.8', () => {
    expect(scaleFromDrag(1, 8800, 8800)).toBe(1.8)
  })
  it('单轴位移取两轴平均(dx=88, dy=0 → +0.5)', () => {
    expect(scaleFromDrag(1, 88, 0)).toBeCloseTo(1.5)
  })
})

describe('usePetResize', () => {
  it('拖动时以 live 相位回调换算后的 scale,松手时以 commit 相位收尾', () => {
    const apply = vi.fn()
    const { result } = renderHook(() => usePetResize(() => 1, apply))
    act(() => { result.current.onPointerDown(down(100, 100)) })
    expect(result.current.isResizing()).toBe(true)
    act(() => { window.dispatchEvent(move(144, 144)) }) // dx=dy=44 → 1 + 44/88 = 1.5
    expect(apply).toHaveBeenCalledWith(1.5, 'live')
    act(() => { window.dispatchEvent(new Event('pointerup')) })
    expect(apply).toHaveBeenLastCalledWith(1.5, 'commit')
  })
  it('起始 scale 来自 getScale,右键不触发', () => {
    const apply = vi.fn()
    const { result } = renderHook(() => usePetResize(() => 1.2, apply))
    act(() => { result.current.onPointerDown({ screenX: 0, screenY: 0, button: 2 }) })
    expect(result.current.isResizing()).toBe(false)
    act(() => { result.current.onPointerDown(down(0, 0)) })
    act(() => { window.dispatchEvent(move(44, 44)) }) // 1.2 + 0.5 = 1.7
    expect(apply).toHaveBeenCalledWith(1.7, 'live')
    act(() => { window.dispatchEvent(new Event('pointerup')) })
  })
  it('pointercancel 与 pointerup 等效收尾(commit + 停止响应 move)', async () => {
    const apply = vi.fn()
    const { result } = renderHook(() => usePetResize(() => 1, apply))
    act(() => { result.current.onPointerDown(down(0, 0)) })
    act(() => { window.dispatchEvent(move(44, 44)) })
    act(() => { window.dispatchEvent(new Event('pointercancel')) })
    expect(apply).toHaveBeenLastCalledWith(1.5, 'commit')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.isResizing()).toBe(false)
    apply.mockClear()
    act(() => { window.dispatchEvent(move(88, 88)) }) // 监听器已卸,不再回调
    expect(apply).not.toHaveBeenCalled()
  })

  it('pointerdown 时调一次 begin 回调(先于任何 apply);右键不触发;整段拖动只调一次', () => {
    const apply = vi.fn()
    const begin = vi.fn()
    const { result } = renderHook(() => usePetResize(() => 1, apply, begin))
    act(() => { result.current.onPointerDown({ screenX: 0, screenY: 0, button: 2 }) })
    expect(begin).not.toHaveBeenCalled()
    act(() => { result.current.onPointerDown(down(0, 0)) })
    expect(begin).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled() // begin 先于任何 live apply
    act(() => { window.dispatchEvent(move(44, 44)) })
    act(() => { window.dispatchEvent(move(88, 88)) })
    act(() => { window.dispatchEvent(new Event('pointerup')) })
    expect(begin).toHaveBeenCalledTimes(1) // 全程只有 pointerdown 那一次
    expect(apply).toHaveBeenLastCalledWith(1.8, 'commit')
  })

  it('松手后下一帧才复位 isResizing(供 click 抑制判断)', async () => {
    const apply = vi.fn()
    const { result } = renderHook(() => usePetResize(() => 1, apply))
    act(() => { result.current.onPointerDown(down(0, 0)) })
    act(() => { window.dispatchEvent(move(20, 20)) })
    act(() => { window.dispatchEvent(new Event('pointerup')) })
    expect(result.current.isResizing()).toBe(true)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.isResizing()).toBe(false)
  })
})
