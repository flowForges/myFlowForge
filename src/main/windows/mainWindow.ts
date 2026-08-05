import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { readSettings } from '../config/store'
import { vibrancyMaterial } from '@shared/vibrancy'

export { vibrancyMaterial }

// The 磨砂度 (blurAmount) the current main window was actually BUILT with. Because vibrancy/transparent
// are construction-time only, this is the baseline the settings UI compares against to decide whether a
// level change truly needs a relaunch (same material bucket → no restart). Updated on each createMainWindow.
let builtBlurAmount = 0
export function builtWindowBlurAmount(): number { return builtBlurAmount }

export function createMainWindow(): BrowserWindow {
  // Frameless, custom traffic-lights. Two visual modes:
  //   • 磨砂度 = 0 → OPAQUE window; whole-window see-through via setOpacity (windowOpacity), live-adjustable.
  //   • 磨砂度 > 0 → TRANSPARENT window + macOS vibrancy so the real desktop shows through frosted (the
  //     designed glass path in glass.css). The material is fixed at creation (changing the level needs a
  //     relaunch — this avoids the live-toggle render glitch that shelved the path); CSS panel blur is live.
  const theme = (() => { try { return readSettings().appearance.theme } catch { return 'light' } })()
  const opacity = (() => { try { return readSettings().appearance.windowOpacity ?? 1 } catch { return 1 } })()
  builtBlurAmount = (() => { try { return readSettings().appearance.blurAmount ?? 0 } catch { return 0 } })()
  const vibrancy = vibrancyMaterial(builtBlurAmount)
  // 让窗口在【光标所在屏(= 启动时用户操作/聚焦的那块屏)】居中,而不是默认居中主屏 —— 多屏下(如外接显示器上
  // 启动)之前无 x/y 会跑到非当前屏。取光标屏的 workArea 居中;取不到(无头/测试环境)则回落 Electron 默认。
  const W = 1280, H = 820
  const pos = (() => {
    try { const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; return { x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + (wa.height - H) / 2) } }
    catch { return {} }
  })()
  const win = new BrowserWindow({
    width: W, height: H, ...pos, show: false,
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
