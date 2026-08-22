import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { readSettings } from '../config/store'
import { logError } from '../log/appLog'
import { CH } from '../ipc/channels'
import { vibrancyMaterial, windowEffect, type VibrancyMaterial, type WinBackgroundMaterial } from '@shared/vibrancy'

export { vibrancyMaterial }

// The 磨砂度 (blurAmount) the current main window was actually BUILT with. Because the window material
// is construction-time only, this is the baseline the settings UI compares against to decide whether a
// level change truly needs a relaunch (same material bucket → no restart). Updated on each createMainWindow.
let builtBlurAmount = 0
export function builtWindowBlurAmount(): number { return builtBlurAmount }

export function createMainWindow(): BrowserWindow {
  // Frameless, custom window controls. Two visual modes:
  //   • 磨砂度 = 0 → OPAQUE window; whole-window see-through via setOpacity (windowOpacity), live-adjustable.
  //   • 磨砂度 > 0 → the platform's native frosted material so the real desktop shows through (the
  //     designed glass path in glass.css). The material is fixed at creation (changing the level needs a
  //     relaunch — this avoids the live-toggle render glitch that shelved the path); CSS panel blur is live.
  const theme = (() => { try { return readSettings().appearance.theme } catch { return 'light' } })()
  const opacity = (() => { try { return readSettings().appearance.windowOpacity ?? 1 } catch { return 1 } })()
  builtBlurAmount = (() => { try { return readSettings().appearance.blurAmount ?? 0 } catch { return 0 } })()
  const effect = windowEffect(builtBlurAmount, process.platform)
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
    ...frostedOptions(effect, theme),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false }
  })
  // Apply 窗口透明度 always so it composes with 磨砂度 (opacity = whole-window see-through; material =
  // frosted blur) rather than being cancelled by any 磨砂度>0. opacity=1 is a no-op, so pure-frosted
  // windows are unaffected. Clamp defensively.
  try { win.setOpacity(Math.min(1, Math.max(0.3, opacity))) } catch { /* platform without opacity support */ }
  // Tell the renderer when the OS maximises/restores us — including paths we never initiate ourselves
  // (double-clicking the drag region, Win+Up, the Windows 11 snap-layouts flyout), which is why this
  // listens to the window instead of echoing from the toggle handler.
  const notifyMaximized = () => { if (!win.isDestroyed()) win.webContents.send(CH.windowMaximizedChanged, win.isMaximized()) }
  win.on('maximize', notifyMaximized)
  win.on('unmaximize', notifyMaximized)
  // Windows drops Electron's default menu (see index.ts) — which also drops its Ctrl+Shift+I devtools
  // accelerator. Keep F12 as the escape hatch: an unsigned build in the wild needs SOME way to open a
  // console when a user reports something. macOS keeps its menu, so it keeps the standard shortcut.
  if (process.platform === 'win32') {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    })
  }
  // ★ 窗口是 show:false 建的,只有 ready-to-show 会让它显示 —— 渲染层加载失败时这个事件【永远不来】,
  // 表现是「进程在、窗口在、但一直不可见」,而且不留任何痕迹。所以加载失败要记一笔,并且照样把窗口显示
  // 出来:一个白窗口配一条日志,远比一个查不到的隐形窗口好。
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logError('window', `主窗口渲染层加载失败 ${code} ${desc} — ${url}`)
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  })
  win.once('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

// The construction-time options that make the window frosted (or flatly opaque).
//
// macOS wants `transparent: true` + a vibrancy material — no opaque fill, or the material is hidden.
// Windows is the opposite: `backgroundMaterial` is IGNORED on a transparent window, so mica/acrylic
// needs transparent to stay FALSE and the fill to be a zero-alpha colour instead. Getting this
// backwards yields a window that is merely see-through with no blur at all.
//
// Flat mode paints a neutral background to avoid a wrong-colour flash before the renderer paints.
function frostedOptions(effect: string | undefined, theme: string): Record<string, unknown> {
  const flat = { backgroundColor: theme === 'dark' ? '#0b0b0d' : '#f4f5f7' }
  if (!effect) return flat
  if (process.platform === 'darwin') return { transparent: true, vibrancy: effect as VibrancyMaterial, backgroundColor: '#00000000' }
  if (process.platform === 'win32') return { backgroundMaterial: effect as WinBackgroundMaterial, backgroundColor: '#00000000' }
  return flat
}
