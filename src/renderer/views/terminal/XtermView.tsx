import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export function XtermView({ termId, active, font }: {
  termId: string; active: boolean; font: { fontFamily: string; fontSize: number }
}) {
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const el = elRef.current!
    const term = new Terminal({ allowProposedApi: true, fontFamily: font.fontFamily, fontSize: font.fontSize,
      cursorBlink: true, theme: readXtermTheme() })
    const fit = new FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon())
    term.open(el)
    // GPU renderer: the default DOM renderer repaints rows as DOM nodes and is slow — with a
    // redraw-heavy shell prompt (powerlevel10k/gitstatus) typing feels laggy. The WebGL addon
    // renders on the GPU (far faster). Load AFTER open(); on WebGL context loss, dispose it so
    // xterm transparently falls back to the DOM renderer instead of freezing.
    //
    // BUT only when window.devicePixelRatio is an integer. The WebGL renderer packs glyphs into an
    // integer-pixel GPU atlas; at a FRACTIONAL device-pixel ratio each cell's advance no longer
    // lines up with xterm's fractional cell layout, so echoed characters drift across the row —
    // "git push" renders as "git p ush", the next keystroke as "ggit push …". Our whole-window zoom
    // (setZoomFactor, keyed off the UI font size: 14px = 1.0×, so e.g. 13px → 0.93×) folds into
    // devicePixelRatio, so on a 2× display any non-14px font size makes it fractional (2×0.93≈1.86).
    // Fall back to the DOM renderer there — it lays out via the browser and stays correct at any
    // zoom. Re-evaluate when the ratio changes (the user changes the UI font size).
    let webgl: WebglAddon | null = null
    const syncRenderer = () => {
      const integral = Number.isInteger(window.devicePixelRatio)
      if (integral && !webgl) {
        try {
          const w = new WebglAddon()
          w.onContextLoss(() => { try { w.dispose() } catch { /* already gone */ } })
          term.loadAddon(w); webgl = w
        } catch { /* no WebGL (rare) → stay on the DOM renderer */ }
      } else if (!integral && webgl) {
        try { webgl.dispose() } catch { /* already gone */ }
        webgl = null
        try { term.refresh(0, term.rows - 1) } catch { /* not visible */ }
      }
    }
    syncRenderer()
    // devicePixelRatio has no 'change' event; a resolution media query fires once when it changes,
    // so re-arm a fresh query against the new value each time.
    let dprQuery: MediaQueryList | null = null
    const onDprChange = () => { syncRenderer(); armDpr() }
    const armDpr = () => {
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange, { once: true })
    }
    armDpr()
    fit.fit()
    termRef.current = term; fitRef.current = fit
    void window.forge.termResize(termId, term.cols, term.rows)
    const offData = window.forge.onTermData(({ termId: id, data }) => { if (id === termId) term.write(data) })
    term.onData(d => window.forge.termWrite(termId, d))
    // Debounce: a live drag fires the observer every frame; refitting + SIGWINCH on each tick makes the
    // shell redraw its prompt repeatedly (the "staircase"). Refit once the size settles instead.
    let refitTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(refitTimer)
      refitTimer = setTimeout(() => {
        try { fit.fit(); window.forge.termResize(termId, term.cols, term.rows) } catch { /* not visible */ }
      }, 90)
    })
    ro.observe(el)
    return () => { offData(); dprQuery?.removeEventListener('change', onDprChange); clearTimeout(refitTimer); ro.disconnect(); term.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  // Re-fit + focus when this tab becomes active.
  useEffect(() => { if (active) { try { fitRef.current?.fit(); termRef.current?.focus() } catch { /* */ } } }, [active])
  // Live-apply font changes.
  useEffect(() => {
    const t = termRef.current; if (!t) return
    t.options.fontFamily = font.fontFamily; t.options.fontSize = font.fontSize
    try { fitRef.current?.fit(); window.forge.termResize(termId, t.cols, t.rows) } catch { /* */ }
  }, [font.fontFamily, font.fontSize, termId])

  // Live-apply theme changes. The palette lives in CSS vars keyed off <html data-theme>; a NEW
  // terminal reads it on mount, but an already-open one keeps its original theme — so a terminal
  // opened in light mode stayed white after switching to dark. Re-read the palette when data-theme
  // flips so existing terminals recolor too.
  useEffect(() => {
    const t = termRef.current; if (!t) return
    const mo = new MutationObserver(() => { t.options.theme = readXtermTheme() })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [termId])

  return <div className="xterm-host" ref={elRef} style={{ display: active ? 'block' : 'none' }} />
}

// Map the app theme (CSS vars) into an xterm theme object.
function readXtermTheme() {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string, fb: string) => (cs.getPropertyValue(n).trim() || fb)
  // selectionInactiveBackground = same as active so the highlight stays visible after the user clicks
  // away to copy (default fades it). See --term-selection (tokens.css) for why xterm needed this.
  const sel = v('--term-selection', 'rgba(120,160,235,0.3)')
  return {
    background: v('--bg', '#0b1020'), foreground: v('--fg-2', '#d6dbe6'), cursor: v('--accent', '#7aa2f7'),
    selectionBackground: sel, selectionInactiveBackground: sel,
  }
}
