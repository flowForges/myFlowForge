// 磨砂度 (0..1) → macOS vibrancy material, or undefined when off. Shared between the main process
// (window creation sets `vibrancy`/`transparent` from this) and the renderer settings UI (to decide
// whether a level change actually needs a window rebuild → relaunch). Electron sets vibrancy/transparent
// at CONSTRUCTION only, so two blurAmounts mapping to the SAME material need no restart; crossing a
// bucket boundary (incl. into/out of "off") does. Keep the buckets in one place so both sides agree.
export type VibrancyMaterial = 'sidebar' | 'under-window' | 'fullscreen-ui'

export function vibrancyMaterial(amount: number | undefined): VibrancyMaterial | undefined {
  const a = amount ?? 0
  if (a <= 0) return undefined
  if (a < 0.4) return 'sidebar'
  if (a < 0.75) return 'under-window'
  return 'fullscreen-ui'
}
