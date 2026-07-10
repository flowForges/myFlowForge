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
  // 应用字体族:非空则覆盖 --font(带系统栈兜底);空则清除,回落到 tokens.css 里的系统字体栈。
  if (a.fontFamily && a.fontFamily.trim()) {
    root.style.setProperty('--font', `${a.fontFamily.trim()}, -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`)
  } else {
    root.style.removeProperty('--font')
  }
  // 文本字重:'medium' 让正文更实、更清晰(global.css 据此提升 body 基础字重并关掉 antialiased)。
  root.setAttribute('data-text-weight', a.textWeight ?? 'medium')
  // Background image: expose the image + its opacity as CSS vars and a scope attribute; the CSS
  // (.app-bg-layer for 'app', .chat::before for 'chat') keys off data-bg-scope. Off when no image.
  const bgOn = !!a.bgImage && a.bgScope && a.bgScope !== 'off'
  root.setAttribute('data-bg-scope', bgOn ? a.bgScope : 'off')
  root.style.setProperty('--app-bg-image', a.bgImage ? `url("${a.bgImage}")` : 'none')
  root.style.setProperty('--app-bg-opacity', String(a.bgOpacity ?? 0.35))
  // 首页背景:独立开关 + 独立图/不透明度。仅 HomeView 的 .home-bg-layer 消费,故只在首页生效,
  // 且盖过 'app' 范围背景(它在 #view-home 内、天然在最底层 .app-bg-layer 之上)。
  const homeBgOn = !!a.homeBgImage && !!a.homeBgOn
  root.setAttribute('data-home-bg', homeBgOn ? 'on' : 'off')
  root.style.setProperty('--home-bg-image', a.homeBgImage ? `url("${a.homeBgImage}")` : 'none')
  root.style.setProperty('--home-bg-opacity', String(a.homeBgOpacity ?? 0.35))
}
