import { useCallback, useRef } from 'react'
import { snapCorner, freeFromWindow } from '@shared/petGeometry'
import type { PetVDir } from '@shared/petGeometry'

const THRESHOLD = 4

export function usePetDrag(
  onDropped: (d: { corner: 'left' | 'right'; free: { x: number; y: number } }) => void,
  getVDir: () => PetVDir = () => 'up',
  getScale: () => number = () => 1
): {
  onPointerDown: (e: React.PointerEvent | { screenX: number; screenY: number; button: number; currentTarget: { setPointerCapture?: (id: number) => void } }) => Promise<void>
  isDragging: () => boolean
} {
  const dragging = useRef(false)
  const start = useRef<{ sx: number; sy: number; wx: number; wy: number; w: number; h: number } | null>(null)
  const workArea = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const last = useRef<{ x: number; y: number } | null>(null)

  const onPointerDown = useCallback(async (e: any) => {
    if (e.button !== 0) return
    if (start.current) return
    const res = await window.forge.petGetBounds()
    if (!res) return
    start.current = { sx: e.screenX, sy: e.screenY, wx: res.bounds.x, wy: res.bounds.y, w: res.bounds.width, h: res.bounds.height }
    workArea.current = res.workArea
    last.current = { x: res.bounds.x, y: res.bounds.y }
    dragging.current = false

    const onMove = (ev: PointerEvent) => {
      const s = start.current; if (!s) return
      const dx = ev.screenX - s.sx, dy = ev.screenY - s.sy
      if (!dragging.current && Math.hypot(dx, dy) < THRESHOLD) return
      dragging.current = true
      const x = s.wx + dx, y = s.wy + dy
      last.current = { x, y }
      window.forge.petSetPosition(x, y)
    }
    const onUp = (_ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const wa = workArea.current, l = last.current, s = start.current
      if (dragging.current && wa && l && s) {
        // The pet may be dragged while EXPANDED (popup open, window 360×560), with the sprite at the
        // window bottom ('up') or top ('down'). `free` must always be the COLLAPSED window's top-left
        // baseline, so derive it via freeFromWindow — otherwise the pet jumps when the popup later
        // closes / re-expands. The result is ABSOLUTE screen coords (global), so it's unambiguous
        // across multiple monitors and restores onto the same display it was dropped on.
        const corner = snapCorner(l.x, s.w, wa)
        // The collapsed baseline depends on the scaled collapsed size — pass the live sprite scale.
        const free = freeFromWindow(l.x, l.y, s.w, s.h, corner, getVDir(), getScale())
        onDropped({ corner, free })
      }
      // keep dragging=true through this tick so the pet widget's onClick in PetApp can call isDragging() to suppress the click-to-open immediately after a drag-release; reset next frame
      setTimeout(() => { dragging.current = false }, 0)
      start.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [onDropped])

  return { onPointerDown, isDragging: () => dragging.current }
}
