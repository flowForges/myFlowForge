import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { resolvePetLayout, MARGIN, petClampRegion, petCollapsedSize, clampPetScale, PET_EXPANDED } from '@shared/petGeometry'

// Re-export the framework-free geometry so existing importers of './petWindow' keep working.
export type { WorkArea, Size, PetVDir, PetLayout } from '@shared/petGeometry'
export { PET_COLLAPSED, PET_EXPANDED, MARGIN, petBounds, snapCorner, posBottomFromBounds, resolvePetLayout, clampPetSprite, petClampRegion } from '@shared/petGeometry'

export function createPetWindow(opts: { corner: 'left' | 'right'; posBottom?: number; free?: { x: number; y: number }; scale?: number }): BrowserWindow {
  const sc = clampPetScale(opts.scale)
  const collapsed = petCollapsedSize(sc)
  // `free` is an ABSOLUTE screen point — restore the pet onto whichever display it was last dropped on
  // (multi-monitor), falling back to the primary display for the legacy corner dock.
  const d = opts.free
    ? screen.getDisplayNearestPoint({ x: Math.round(opts.free.x + collapsed.width / 2), y: Math.round(opts.free.y + collapsed.height / 2) })
    : screen.getPrimaryDisplay()
  const wa = petClampRegion(d.bounds, d.workArea)
  const { x, y } = resolvePetLayout(wa, opts, false, MARGIN, PET_EXPANDED, sc)
  const win = new BrowserWindow({
    width: collapsed.width, height: collapsed.height, x, y, show: false,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    minimizable: false, maximizable: false, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false }
  })
  // Keep the pet OUT of the macOS「窗口」menu and the Dock icon's right-click window list — it's a
  // floating companion, not a document window (skipTaskbar above only covers Windows). Harmless on
  // other platforms; guarded in case an older Electron lacks the property setter.
  try { win.excludedFromShownWindowsMenu = true } catch { /* best-effort — cosmetic only */ }
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.once('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`)
  else win.loadFile(join(__dirname, '../renderer/pet.html'))
  return win
}
