import { useCallback, useRef } from 'react'
import { clampPetScale, PET_SPRITE } from '@shared/petGeometry'

// Pure conversion: a diagonal drag delta (px, screen coords) → new scale. Dragging toward the
// bottom-right (positive dx+dy) grows the sprite; the two axes are averaged so a pure-horizontal or
// pure-vertical drag still works, and one base-sprite-width (88px) of average travel = +1.0 scale.
// The result is clamped into [PET_SCALE_MIN, PET_SCALE_MAX].
export function scaleFromDrag(startScale: number, dx: number, dy: number, base: number = PET_SPRITE): number {
  return clampPetScale(startScale + (dx + dy) / (2 * base))
}

// Mirrors usePetDrag's pointer pattern: pointerdown on the resize handle records the start point +
// starting scale and fires `begin` ONCE (the caller pre-grows the window to the max-scale footprint
// via petResizeBegin, so the live drag never re-bounds the window); window-level pointermove converts
// the diagonal delta into a live scale (`apply` with phase 'live' — pure CSS-var update, zero IPC);
// pointerup commits the final value (phase 'commit' — the caller persists once via petSetScale, whose
// dockPet shrinks the window back around the final size). Screen coords are used so a window re-bound
// mid-resize never corrupts the deltas.
export function usePetResize(
  getScale: () => number,
  apply: (scale: number, phase: 'live' | 'commit') => void,
  begin?: () => void
): {
  onPointerDown: (e: { screenX: number; screenY: number; button: number }) => void
  isResizing: () => boolean
} {
  const start = useRef<{ sx: number; sy: number; s0: number } | null>(null)
  const resizing = useRef(false)
  const last = useRef(1)

  const onPointerDown = useCallback((e: { screenX: number; screenY: number; button: number }) => {
    if (e.button !== 0 || start.current) return
    start.current = { sx: e.screenX, sy: e.screenY, s0: getScale() }
    last.current = start.current.s0
    resizing.current = true
    begin?.()

    const onMove = (ev: PointerEvent) => {
      const s = start.current; if (!s) return
      const sc = scaleFromDrag(s.s0, ev.screenX - s.sx, ev.screenY - s.sy)
      if (sc !== last.current) { last.current = sc; apply(sc, 'live') }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      apply(last.current, 'commit')
      start.current = null
      // keep resizing=true through this tick so the pet's onClick can suppress the click-to-open
      // right after a resize-release; reset next frame (same convention as usePetDrag).
      setTimeout(() => { resizing.current = false }, 0)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // A cancelled pointer (window re-bound mid-drag, OS gesture) must still commit + release the
    // listeners, or `resizing` sticks true and the move/up handlers leak.
    window.addEventListener('pointercancel', onUp)
  }, [getScale, apply, begin])

  return { onPointerDown, isResizing: () => resizing.current }
}
