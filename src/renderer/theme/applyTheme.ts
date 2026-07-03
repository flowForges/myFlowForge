import type { Appearance } from '@shared/types'

export function prefersDark(): boolean {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

export function applyTheme(a: Appearance): void {
  const root = document.documentElement
  const theme = a.theme === 'auto' ? (prefersDark() ? 'dark' : 'light') : a.theme
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-accent', a.accent)
  root.setAttribute('data-vibrancy', a.vibrancy ? 'on' : 'off')
  // 磨砂度 drives the glass system: any blurAmount > 0 turns on the frosted-panel CSS (data-glass) and
  // scales the panel backdrop-blur via a CSS var (0..1 → 0..designed strength). The window-level desktop
  // vibrancy is handled in the main process at window creation. Keep the legacy `glass` flag as an OR.
  const blur = a.blurAmount ?? 0
  root.setAttribute('data-glass', blur > 0 || a.glass ? 'on' : 'off')
  root.style.setProperty('--glass-blur-strength', String(blur > 0 ? blur : 1))
  root.setAttribute('data-density', a.density)
  root.setAttribute('data-font', a.fontSize)
}
