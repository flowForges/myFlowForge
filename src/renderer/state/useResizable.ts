import { useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export function clampWidth(w: number, min: number, max: number): number {
  return Math.max(min, Math.min(w, max))
}

export function loadWidth(key: string, def: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem('forge.' + key)
    if (raw === null) return def
    const parsed = parseFloat(raw)
    if (!isFinite(parsed)) return def
    return clampWidth(parsed, min, max)
  } catch {
    return def
  }
}

export function useResizable(
  key: string,
  def: number,
  min: number,
  max: number,
  grow: 'right' | 'left',
): { width: number; onHandleDown: (e: ReactPointerEvent) => void } {
  const [width, setWidth] = useState(() => loadWidth(key, def, min, max))

  const onHandleDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width

    document.documentElement.setAttribute('data-resizing', '')

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const next = clampWidth(startW + (grow === 'right' ? dx : -dx), min, max)
      setWidth(next)
    }

    const onUp = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const next = clampWidth(startW + (grow === 'right' ? dx : -dx), min, max)
      setWidth(next)
      try {
        localStorage.setItem('forge.' + key, String(next))
      } catch {
        // ignore
      }
      document.documentElement.removeAttribute('data-resizing')
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  return { width, onHandleDown }
}
