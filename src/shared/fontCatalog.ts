// Curated free fonts available for ON-DEMAND download. We ship only this tiny metadata — the actual
// font files are fetched from the Fontsource CDN (jsDelivr) when the user asks, so the installer stays
// small. Every listed font is SIL OFL / Apache-2.0 licensed (free to use, embed, and redistribute,
// including commercially). CJK fonts are large (hundreds of unicode-range glyph subsets) and flagged
// so the UI can warn about the download size; on macOS the system already ships 苹方 (PingFang SC),
// which the local-font picker surfaces without any download.
export type FontCatalogEntry = {
  id: string          // Fontsource package id — also the on-disk directory name under fonts/
  family: string      // the CSS font-family the @font-face declares (what gets stored in settings)
  label: string       // human-facing name in the picker
  category: 'sans' | 'serif' | 'mono'
  cjk: boolean        // true = large; the UI shows a size warning
  license: string
  weights: number[]   // which weights to download (each weight = one Fontsource stylesheet)
  approxBytes: number // rough total download size, for the UI (real size is reported live by progress)
}

export const FONTSOURCE_CDN = 'https://cdn.jsdelivr.net/npm/@fontsource'

// The per-weight stylesheet URLs for a catalog entry, e.g. .../inter@latest/400.css.
export function fontCssUrls(entry: FontCatalogEntry): string[] {
  return entry.weights.map(w => `${FONTSOURCE_CDN}/${entry.id}@latest/${w}.css`)
}

// Absolute URL of one woff2 file referenced (relatively, as ./files/<name>) by a Fontsource stylesheet.
export function fontFileUrl(id: string, name: string): string {
  return `${FONTSOURCE_CDN}/${id}@latest/files/${name}`
}

export const FONT_CATALOG: FontCatalogEntry[] = [
  // 界面字体(比例):供「应用字体」选择器。
  { id: 'inter', family: 'Inter', label: 'Inter', category: 'sans', cjk: false, license: 'OFL-1.1', weights: [400, 500, 600, 700], approxBytes: 320_000 },
  { id: 'ibm-plex-sans', family: 'IBM Plex Sans', label: 'IBM Plex Sans', category: 'sans', cjk: false, license: 'OFL-1.1', weights: [400, 500, 600], approxBytes: 240_000 },
  { id: 'source-sans-3', family: 'Source Sans 3', label: 'Source Sans 3', category: 'sans', cjk: false, license: 'OFL-1.1', weights: [400, 600], approxBytes: 140_000 },
  { id: 'noto-sans-sc', family: 'Noto Sans SC', label: '思源黑体 Noto Sans SC · 简体中文', category: 'sans', cjk: true, license: 'OFL-1.1', weights: [400, 500], approxBytes: 12_000_000 },
  // 等宽字体(coding):供「终端字体」选择器。均为纯等宽(非 Nerd 补丁版);要 powerline/图标字形需自行安装
  // Nerd Font,它会出现在本机字体列表里可直接选。
  { id: 'jetbrains-mono', family: 'JetBrains Mono', label: 'JetBrains Mono', category: 'mono', cjk: false, license: 'OFL-1.1', weights: [400, 700], approxBytes: 180_000 },
  { id: 'fira-code', family: 'Fira Code', label: 'Fira Code(连字)', category: 'mono', cjk: false, license: 'OFL-1.1', weights: [400, 500], approxBytes: 200_000 },
  { id: 'ibm-plex-mono', family: 'IBM Plex Mono', label: 'IBM Plex Mono', category: 'mono', cjk: false, license: 'OFL-1.1', weights: [400, 500], approxBytes: 140_000 },
  { id: 'source-code-pro', family: 'Source Code Pro', label: 'Source Code Pro', category: 'mono', cjk: false, license: 'OFL-1.1', weights: [400, 500], approxBytes: 150_000 },
]

export function catalogEntry(id: string): FontCatalogEntry | undefined {
  return FONT_CATALOG.find(e => e.id === id)
}
