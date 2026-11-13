// The physical-press check every widening computer-use control shares (spec V5; I-2): the overlay's 允许 / 继续, the
// main-window card's 允许 / 继续, and the composer's off→on / ask→allow mode items.
//
// A press counts only when the OS reported (isTrusted) a mousedown on that same control within the last second, and
// its click carries a click count (`detail > 0`). Keyboard activation and AXPress (System Events `click button`) report
// detail 0; script-dispatched events aren't trusted. Those controls also take `tabIndex={-1}`, so Tab can't reach them.
// Narrowing controls (拒绝, 停止, 关闭, allow→ask) don't use this: they stay keyboard-reachable.
import { useRef, type MouseEvent } from 'react'

export const PHYSICAL_MS = 1000

export type IsPhysical = (e: MouseEvent) => boolean
export const trustedMouse: IsPhysical = (e) => e.nativeEvent.isTrusted === true

export interface PhysicalPress {
  /** onMouseDown for every button in the group: a press elsewhere clears the record */
  down: (id: string) => (e: MouseEvent) => void
  /** in onClick: was this click the end of a physical press on `id`? Consumes the record. */
  check: (id: string, e: MouseEvent) => boolean
}

export function usePhysicalPress(isPhysical: IsPhysical = trustedMouse): PhysicalPress {
  const rec = useRef<{ id: string; t: number } | null>(null)
  return {
    down: (id) => (e) => { rec.current = isPhysical(e) ? { id, t: performance.now() } : null },
    check: (id, e) => {
      const d = rec.current
      rec.current = null
      return !!d && d.id === id && isPhysical(e) && e.detail > 0 && performance.now() - d.t <= PHYSICAL_MS
    },
  }
}
