import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePetDrag } from './usePetDrag'

let setPosition: ReturnType<typeof vi.fn>
beforeEach(() => {
  setPosition = vi.fn()
  ;(window as any).forge = {
    petGetBounds: vi.fn(async () => ({ bounds: { x: 1200, y: 600, width: 140, height: 120 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
    petSetPosition: setPosition
  }
})

function down(x: number, y: number) { return { clientX: x, clientY: y, screenX: x, screenY: y, button: 0, preventDefault() {}, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} }, pointerId: 1 } as any }

function move(screenX: number, screenY: number) {
  const ev = new Event('pointermove')
  ;(ev as any).screenX = screenX
  ;(ev as any).screenY = screenY
  return ev
}

describe('usePetDrag', () => {
  it('does not drag below the threshold and reports not dragging', async () => {
    const onDropped = vi.fn()
    const { result } = renderHook(() => usePetDrag(onDropped))
    await act(async () => { await result.current.onPointerDown(down(1200, 600)) })
    act(() => { window.dispatchEvent(move(1202, 601)) })
    expect(result.current.isDragging()).toBe(false)
    expect(setPosition).not.toHaveBeenCalled()
  })

  it('drags past threshold, moves the window, and reports free position + derived corner on pointerup', async () => {
    const onDropped = vi.fn()
    const { result } = renderHook(() => usePetDrag(onDropped))
    await act(async () => { await result.current.onPointerDown(down(1200, 600)) })
    // move left+up by 1100,80 → window to x≈100, y≈680
    act(() => { window.dispatchEvent(move(100, 680)) })
    expect(result.current.isDragging()).toBe(true)
    expect(setPosition).toHaveBeenCalled()
    act(() => { window.dispatchEvent(new Event('pointerup')) })
    // final window left ≈ 1200 + (100-1200) = 100; workArea.x=0 → free.x=100
    // final window top ≈ 600 + (680-600) = 680; workArea.y=0 → free.y=680
    // center 170 < 720 → corner='left'
    expect(onDropped).toHaveBeenCalledWith({ corner: 'left', free: { x: 100, y: 680 } })
    expect(onDropped.mock.calls[0][0].corner).toBe('left')
  })

  it('dragging while EXPANDED (popup open) reports the COLLAPSED baseline, not the window top-left', async () => {
    // window is the expanded popup size 360×560; drag it so its top-left lands at (800,200).
    ;(window as any).forge.petGetBounds = vi.fn(async () => ({ bounds: { x: 600, y: 100, width: 360, height: 560 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } }))
    const onDropped = vi.fn()
    const { result } = renderHook(() => usePetDrag(onDropped))
    await act(async () => { await result.current.onPointerDown(down(600, 100)) })
    act(() => { window.dispatchEvent(move(800, 200)) })   // window top-left → (800,200)
    act(() => { window.dispatchEvent(new Event('pointerup')) })
    // sprite bottom-right = (800+360, 200+560) = (1160,760); corner: center 980 > 720 → 'right'
    // collapsed baseline = (1160-140, 760-120) = (1020, 640)
    expect(onDropped).toHaveBeenCalledWith({ corner: 'right', free: { x: 1020, y: 640 } })
  })
})
