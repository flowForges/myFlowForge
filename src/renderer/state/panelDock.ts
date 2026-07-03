import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, CSSProperties } from 'react'

/* Bottom dock holding the log console + terminal. Ported from the prototype's panel-dock:
 * the two panels can stack (上下) or sit side-by-side (左右), each resizable, and the dock
 * container (bounded top→bottom, overflow:hidden) keeps them from ever crossing the app top. */

export type DockLayout = 'stack' | 'split'
export type DockPanel = 'log' | 'term'

const LOG_MIN = 180
const TERM_MIN = 190
const DOCK_MIN = 220
const FLOOR = 110 // hard minimum when both panels must be squeezed to fit
const RATIO_MIN = 0.2
const RATIO_MAX = 0.8

/** Clamp a panel height into [min, max], rounding. If max < min (no room), max wins so the
 *  panel shrinks below its preferred minimum rather than overflow. */
export function clampPanel(v: number, min: number, max: number): number {
  const lo = Math.min(min, max)
  return Math.max(lo, Math.min(max, Math.round(v)))
}

/** Scale two stacked panel heights down so their sum fits `avail`, respecting soft floors.
 *  Mirrors the prototype's fitStackHeights — the guarantee that the stack never overflows. */
export function fitStack(
  logH: number, termH: number, avail: number, logMin = LOG_MIN, termMin = TERM_MIN,
): { logH: number; termH: number } {
  if (logH + termH <= avail) return { logH: Math.round(logH), termH: Math.round(termH) }
  const floorLog = Math.min(logMin, Math.max(FLOOR, avail - termMin))
  const floorTerm = Math.min(termMin, Math.max(FLOOR, avail - floorLog))
  const scale = avail / (logH + termH)
  let log = Math.max(floorLog, Math.round(logH * scale))
  let term = Math.max(floorTerm, avail - log)
  if (log + term > avail) log = Math.max(floorLog, avail - term)
  return { logH: log, termH: term }
}

/** Move the stack divider: the terminal grows by `deltaUp` while the log shrinks by the same
 *  amount (their sum is preserved), so the terminal can always be dragged up by squeezing the log. */
export function moveBoundary(
  startTerm: number, deltaUp: number, sum: number, termMin = TERM_MIN, logMin = LOG_MIN,
): { termH: number; logH: number } {
  const termH = clampPanel(startTerm + deltaUp, termMin, sum - logMin)
  return { termH, logH: sum - termH }
}

/** Clamp the side-by-side width ratio (log's share) into [0.2, 0.8]. */
export function clampRatio(r: number): number {
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, r))
}

const loadStr = (key: string): string | null => {
  try { return localStorage.getItem('forge.' + key) } catch { return null }
}
const load = (key: string, def: number): number => {
  const n = parseInt(loadStr(key) || '', 10)
  return isNaN(n) ? def : n
}
const loadFloat = (key: string, def: number): number => {
  const n = parseFloat(loadStr(key) || '')
  return isNaN(n) ? def : n
}
const save = (key: string, v: number | string) => {
  try { localStorage.setItem('forge.' + key, String(v)) } catch { /* ignore */ }
}

export interface PanelDockApi {
  dockRef: React.RefObject<HTMLDivElement | null>
  dockClass: string
  dockStyle: CSSProperties
  layout: DockLayout
  toggleLayout: () => void
  /** Pointer-down handler factory for a panel's top resize handle (height). */
  startResize: (panel: DockPanel) => (e: ReactPointerEvent) => void
  /** Pointer-down handler for the vertical divider in split mode (left/right ratio). */
  startSplitResize: (e: ReactPointerEvent) => void
  focused: DockPanel | null
  setFocus: (panel: DockPanel) => void
}

export function usePanelDock(logOpen: boolean, termOpen: boolean): PanelDockApi {
  const both = logOpen && termOpen
  const [layout, setLayout] = useState<DockLayout>(() => loadStr('dockLayout') === 'split' ? 'split' : 'stack')
  const [logH, setLogH] = useState(() => load('logH', 312))
  const [termH, setTermH] = useState(() => load('termH', 360))
  const [dockH, setDockH] = useState(() => load('dockH', 420))
  const [ratio, setRatio] = useState(() => clampRatio(loadFloat('splitRatio', 0.5)))
  const [focused, setFocused] = useState<DockPanel | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)

  const availableH = useCallback(() => {
    const h = dockRef.current?.getBoundingClientRect().height
    return Math.max(260, Math.floor(h || (typeof window !== 'undefined' ? window.innerHeight - 76 : 600)))
  }, [])

  // Keep heights within the available space whenever the stack composition or viewport changes,
  // so two open panels are auto-fitted (never overflow the app top). Single panels are full-height
  // via CSS, so only the stacked pair needs fitting here.
  useEffect(() => {
    const sync = () => {
      const avail = availableH()
      if (both && layout === 'split') {
        setDockH(d => clampPanel(d, DOCK_MIN, avail))
      } else if (both) {
        const f = fitStack(logH, termH, avail)
        setLogH(f.logH); setTermH(f.termH)
      } else {
        // Single panel: keep its own (resizable) height, just clamp so it can't exceed the dock.
        setLogH(l => clampPanel(l, LOG_MIN, avail))
        setTermH(t => clampPanel(t, TERM_MIN, avail))
      }
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, both, logOpen, termOpen])

  const setFocus = useCallback((panel: DockPanel) => setFocused(panel), [])

  const toggleLayout = useCallback(() => {
    setLayout(prev => { const next = prev === 'split' ? 'stack' : 'split'; save('dockLayout', next); return next })
  }, [])

  const startResize = useCallback((panel: DockPanel) => (e: ReactPointerEvent) => {
    e.preventDefault()
    // Split-resize semantics only apply when BOTH are open side-by-side; a lone panel always resizes
    // its own height (so closing one leaves a normal, draggable bottom panel).
    const split = layout === 'split' && both
    const startY = e.clientY
    document.documentElement.setAttribute('data-resizing', '')

    let onMove: (ev: PointerEvent) => void
    if (!split && both && panel === 'term') {
      // Stack divider: terminal grows / log shrinks (sum preserved) — drag the terminal up freely.
      const sum = termH + logH
      const startTerm = termH
      onMove = ev => { const r = moveBoundary(startTerm, startY - ev.clientY, sum); setTermH(r.termH); setLogH(r.logH) }
    } else {
      // Split → shared dock height; stack top handle (log) → that panel's height.
      const startV = split ? dockH : panel === 'log' ? logH : termH
      const min = split ? DOCK_MIN : panel === 'log' ? LOG_MIN : TERM_MIN
      const at = (cy: number) => {
        let max = availableH()
        if (!split && both) max = Math.max(96, availableH() - (panel === 'log' ? termH : logH))
        return clampPanel(startV + (startY - cy), min, max)
      }
      onMove = ev => { const v = at(ev.clientY); if (split) setDockH(v); else if (panel === 'log') setLogH(v); else setTermH(v) }
    }

    // State updates during the drag drive the CSS vars on the dock; read them back on release to persist.
    const readVar = (name: string, fb: number) => {
      const el = dockRef.current
      if (!el) return fb
      const v = parseFloat(getComputedStyle(el).getPropertyValue(name))
      return isNaN(v) ? fb : v
    }
    const onUp = (ev: PointerEvent) => {
      onMove(ev)
      requestAnimationFrame(() => {
        if (split) save('dockH', readVar('--dock-h', dockH))
        else { save('logH', readVar('--log-h', logH)); save('termH', readVar('--term-h', termH)) }
      })
      document.documentElement.removeAttribute('data-resizing')
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [layout, dockH, logH, termH, both, availableH])

  const startSplitResize = useCallback((e: ReactPointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startR = ratio
    const w = dockRef.current?.getBoundingClientRect().width || (typeof window !== 'undefined' ? window.innerWidth : 1200)
    document.documentElement.setAttribute('data-resizing', '')
    const at = (cx: number) => clampRatio(startR + (cx - startX) / w)
    const onMove = (ev: PointerEvent) => setRatio(at(ev.clientX))
    const onUp = (ev: PointerEvent) => {
      const r = at(ev.clientX)
      setRatio(r); save('splitRatio', r)
      document.documentElement.removeAttribute('data-resizing')
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [ratio])

  const dockClass = `panel-dock${both ? ' both-open' : ''}${layout === 'split' ? ' split' : ''}`
  const dockStyle = {
    ['--log-h']: `${logH}px`,
    ['--term-h']: `${termH}px`,
    ['--dock-h']: `${dockH}px`,
    ['--split-ratio']: `${ratio}`,
  } as CSSProperties

  return { dockRef, dockClass, dockStyle, layout, toggleLayout, startResize, startSplitResize, focused, setFocus }
}
