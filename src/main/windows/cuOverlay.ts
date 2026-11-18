// The computer-use indicator (spec §6 T4, §10.4, V9): a pill at the top centre of the primary display,
// `● 电脑 · <title> · <mode>` + 停止, expanding into a mini approval card while a gate is pending.
//
// - `type:'panel'` + `focusable:false`: a non-activating panel, so clicking 允许 doesn't bring myFlowForge to the front
//   and the approved click still lands on the target app (V9, 实测 31). It is only ever shown with `showInactive()`.
// - `acceptFirstMouse`: the panel never becomes key, so every click is a "first" click; without it the first one would
//   only be swallowed.
// - Built lazily on the first show: with computer use never turned on, no window exists.
// - State is pushed with webContents.send on its own channel; the overlay is not in the window registry, so it never
//   receives chat or any other broadcast.
// - No import from electron (coreBoundary.test.ts): index.ts injects the window factory; the options type is the global
//   `Electron` namespace's.
type BrowserWindowConstructorOptions = Electron.BrowserWindowConstructorOptions
import { CU_OVERLAY_ARG, type CuOverlayState } from '@shared/computerUse'
import { CH } from '../ipc/channels'

export const OVERLAY_W = 420
export const OVERLAY_H = 36
export const OVERLAY_EXPANDED_H = 220
/** marks the overlay's renderer for the preload, which then exposes only the `cuOverlay` bridge */
export const OVERLAY_ARG = CU_OVERLAY_ARG

interface Bounds { x: number; y: number; width: number; height: number }
export interface WinLike {
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void
  setVisibleOnAllWorkspaces(flag: boolean, o?: { visibleOnFullScreen?: boolean }): void
  setBounds(b: Bounds): void
  showInactive(): void
  /** macOS: sharingType none, so our own captures never see it */
  setContentProtection(flag: boolean): void
  hide(): void
  isVisible(): boolean
  isDestroyed(): boolean
  destroy(): void
  on(event: 'closed', fn: () => void): void
  webContents: { id: number; send(channel: string, payload: unknown): void; on(event: 'did-finish-load' | 'render-process-gone', fn: () => void): void }
}
export interface ScreenLike { getPrimaryDisplay(): { workArea: Bounds } }

/** Fix round 1 (reviewer finding 3): a crash loop (bad renderer bundle, GPU churn, …) must not rebuild forever —
 *  at most this many rebuilds inside the rolling window, then it gives up until the next explicit `show()`. */
const REBUILD_LIMIT = 3
const REBUILD_WINDOW_MS = 10_000

export interface CuOverlay {
  show(state: CuOverlayState): void
  hide(): void
  dispose(): void
  /** the live overlay's webContents id, for the I-1 sender check; null when there is none */
  webContentsId(): number | null
}

function place(screen: ScreenLike, height: number): Bounds {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: Math.round(wa.x + (wa.width - OVERLAY_W) / 2), y: wa.y + 6, width: OVERLAY_W, height }
}

export function createCuOverlay(d: {
  makeWindow: (o: BrowserWindowConstructorOptions) => WinLike
  screen: ScreenLike
  loadUrl: (w: WinLike) => void
  /** the preload script path (the shared one; OVERLAY_ARG narrows what it exposes) */
  preload?: string
}): CuOverlay {
  let win: WinLike | null = null
  let last: CuOverlayState | null = null
  // Fix round 1 (reviewer finding 2): `visible` tracks whether we're supposed to be on screen right now —
  // cleared by hide(), set by present(). A dead renderer that was already hidden must not come back; the next
  // explicit show() rebuilds from scratch instead.
  let visible = false
  // Fix round 1 (finding 3): timestamps of recent auto-rebuilds, for the crash-loop cap.
  let rebuilds: number[] = []

  const ensure = (height: number): WinLike => {
    if (win && !win.isDestroyed()) return win
    const b = place(d.screen, height)
    const w = d.makeWindow({
      type: 'panel', frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, width: b.width, height: b.height, x: b.x, y: b.y, show: false,
      minimizable: false, maximizable: false, fullscreenable: false, acceptFirstMouse: true, backgroundColor: '#00000000',
      webPreferences: { preload: d.preload, contextIsolation: true, sandbox: false, additionalArguments: [OVERLAY_ARG] },
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    w.setContentProtection(true)
    w.on('closed', () => { if (win === w) win = null })
    w.webContents.on('did-finish-load', () => { if (last && !w.isDestroyed()) w.webContents.send(CH.cuOverlayState, last) })
    // T10 carry-over, fix round 1: the renderer can crash or be killed by the OS. `recover` rebuilds the window
    // and replays whatever state was last shown, so a pending gate reappears instead of leaving the user with no
    // way to answer it — but deferred (not run on the crash event's own call stack) and capped (finding 3).
    w.webContents.on('render-process-gone', () => { setTimeout(() => recover(w), 0) })
    win = w
    d.loadUrl(w)
    return w
  }

  const present = (state: CuOverlayState) => {
    last = state
    const height = state.gate ? OVERLAY_EXPANDED_H : OVERLAY_H
    const w = ensure(height)
    w.setBounds(place(d.screen, height))
    w.webContents.send(CH.cuOverlayState, state)
    if (!w.isVisible()) w.showInactive()
    visible = true
  }

  /** at most REBUILD_LIMIT auto-rebuilds per REBUILD_WINDOW_MS; old attempts age out of the window. */
  const canAutoRebuild = (): boolean => {
    const now = Date.now()
    rebuilds = rebuilds.filter((t) => now - t < REBUILD_WINDOW_MS)
    if (rebuilds.length >= REBUILD_LIMIT) return false
    rebuilds.push(now)
    return true
  }

  const recover = (dead: WinLike) => {
    if (win !== dead) return // a stale event from a window that was already replaced: nothing to do
    win = null
    try { if (!dead.isDestroyed()) dead.destroy() } catch { /* already gone */ }
    // finding 2: don't resurrect a panel the caller already hid (or that never had a state to show).
    if (!visible || !last) return
    // finding 3: a crash loop gives up instead of rebuilding forever; an explicit show() is unaffected by this cap.
    if (!canAutoRebuild()) return
    present(last)
  }

  return {
    show(state) { present(state) },
    hide() {
      visible = false
      if (win && !win.isDestroyed()) win.hide()
    },
    webContentsId: () => (win && !win.isDestroyed() ? win.webContents.id : null),
    dispose() {
      visible = false
      rebuilds = []
      const w = win
      win = null
      last = null
      if (w && !w.isDestroyed()) w.destroy()
    },
  }
}
