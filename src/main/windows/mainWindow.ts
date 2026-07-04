import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readSettings } from '../config/store'

// 磨砂度 (0..1) → macOS vibrancy material, or undefined when off. The glass.css system (see its header)
// expects a transparent + `under-window`-style window so the real desktop shows through frosted; we pick
// a progressively stronger material as the amount rises. Set at window CREATION only.
export function vibrancyMaterial(amount: number | undefined): 'sidebar' | 'under-window' | 'fullscreen-ui' | undefined {
  const a = amount ?? 0
  if (a <= 0) return undefined
  if (a < 0.4) return 'sidebar'
  if (a < 0.75) return 'under-window'
  return 'fullscreen-ui'
}

export function createMainWindow(): BrowserWindow {
  // Frameless, custom traffic-lights. Two visual modes:
  //   • 磨砂度 = 0 → OPAQUE window; whole-window see-through via setOpacity (windowOpacity), live-adjustable.
  //   • 磨砂度 > 0 → TRANSPARENT window + macOS vibrancy so the real desktop shows through frosted (the
  //     designed glass path in glass.css). The material is fixed at creation (changing the level needs a
  //     relaunch — this avoids the live-toggle render glitch that shelved the path); CSS panel blur is live.
  const theme = (() => { try { return readSettings().appearance.theme } catch { return 'light' } })()
  const opacity = (() => { try { return readSettings().appearance.windowOpacity ?? 1 } catch { return 1 } })()
  const vibrancy = (() => { try { return vibrancyMaterial(readSettings().appearance.blurAmount) } catch { return undefined } })()
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    frame: false,
    roundedCorners: true,
    // Frosted: transparent + vibrancy (no opaque fill so the material shows). Flat: neutral bg to avoid
    // a wrong-colour flash before the renderer paints.
    ...(vibrancy
      ? { transparent: true, vibrancy, backgroundColor: '#00000000' }
      : { backgroundColor: theme === 'dark' ? '#0b0b0d' : '#f4f5f7' }),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false }
  })
  // Apply 窗口透明度 always so it composes with 磨砂度 (opacity = whole-window see-through; vibrancy =
  // frosted blur) rather than being cancelled by any 磨砂度>0. opacity=1 is a no-op, so pure-frosted
  // windows are unaffected. Clamp defensively.
  try { win.setOpacity(Math.min(1, Math.max(0.3, opacity))) } catch { /* platform without opacity support */ }
  win.once('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}
