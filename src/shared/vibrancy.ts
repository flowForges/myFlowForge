// 磨砂度 (0..1) → the native window material for this platform, or undefined when off. Shared between
// the main process (window creation) and the renderer settings UI (to decide whether a level change
// actually needs a window rebuild → relaunch). Electron sets these at CONSTRUCTION only, so two
// blurAmounts mapping to the SAME material need no restart; crossing a bucket boundary (incl.
// into/out of "off") does. Keep the buckets in one place so both sides agree.
export type VibrancyMaterial = 'sidebar' | 'under-window' | 'fullscreen-ui'

// Windows has its own system-drawn materials instead of macOS vibrancy. Only `mica` and `acrylic`
// are used: `tabbed` is a mica variant meant for tab-strip windows, and `auto`/`none` are not
// materials. Windows 11 22H2+ only — older builds simply ignore it and draw an opaque window.
export type WinBackgroundMaterial = 'mica' | 'acrylic'

export function vibrancyMaterial(amount: number | undefined): VibrancyMaterial | undefined {
  const a = amount ?? 0
  if (a <= 0) return undefined
  if (a < 0.4) return 'sidebar'
  if (a < 0.75) return 'under-window'
  return 'fullscreen-ui'
}

// Windows only gets two useful steps: mica is the subtle desktop-tinted material, acrylic the heavy
// translucent blur. Fewer buckets than macOS on purpose — inventing a third from `tabbed` would map
// the slider onto a material that isn't a stronger blur, just a differently-tinted one.
export function windowsBackgroundMaterial(amount: number | undefined): WinBackgroundMaterial | undefined {
  const a = amount ?? 0
  if (a <= 0) return undefined
  return a < 0.75 ? 'mica' : 'acrylic'
}

// The material this platform would actually build the window with. Doubles as the comparison key for
// "does changing 磨砂度 need a relaunch" — same value → same window, no restart.
export function windowEffect(amount: number | undefined, platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return vibrancyMaterial(amount)
  if (platform === 'win32') return windowsBackgroundMaterial(amount)
  return undefined
}
