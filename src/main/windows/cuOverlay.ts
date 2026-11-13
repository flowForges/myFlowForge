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
  hide(): void
  isVisible(): boolean
  isDestroyed(): boolean
  destroy(): void
  on(event: 'closed', fn: () => void): void
  webContents: { id: number; send(channel: string, payload: unknown): void; on(event: 'did-finish-load', fn: () => void): void }
}
export interface ScreenLike { getPrimaryDisplay(): { workArea: Bounds } }

export interface CuOverlay {
  show(state: CuOverlayState): void
  hide(): void
  collapseMain: () => void
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
  /** the 收起主窗口 button */
  collapseMain?: () => void
}): CuOverlay {
  let win: WinLike | null = null
  let last: CuOverlayState | null = null

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
    w.on('closed', () => { if (win === w) win = null })
    w.webContents.on('did-finish-load', () => { if (last && !w.isDestroyed()) w.webContents.send(CH.cuOverlayState, last) })
    win = w
    d.loadUrl(w)
    return w
  }

  return {
    show(state) {
      last = state
      const height = state.gate ? OVERLAY_EXPANDED_H : OVERLAY_H
      const w = ensure(height)
      w.setBounds(place(d.screen, height))
      w.webContents.send(CH.cuOverlayState, state)
      if (!w.isVisible()) w.showInactive()
    },
    hide() {
      if (win && !win.isDestroyed()) win.hide()
    },
    collapseMain: () => d.collapseMain?.(),
    webContentsId: () => (win && !win.isDestroyed() ? win.webContents.id : null),
    dispose() {
      const w = win
      win = null
      last = null
      if (w && !w.isDestroyed()) w.destroy()
    },
  }
}
