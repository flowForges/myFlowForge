// File-type badge (.fic) — maps a file extension to a short label glyph + brand color, ported 1:1
// from the prototype's LANG map / ficFor(). The badge shape/size is constant; only the background
// color + label vary by type ("不同类型文件展示的形态不一样"). Light-background types carry an
// explicit dark text color so the glyph stays legible.

interface Lang { lab: string; c: string; lang: string; dark?: string }

const LANG: Record<string, Lang> = {
  ts:   { lab: 'TS',   c: 'oklch(58% .14 250)', lang: 'ts' },
  tsx:  { lab: 'TSX',  c: 'oklch(58% .14 250)', lang: 'ts' },
  js:   { lab: 'JS',   c: 'oklch(74% .14 88)',  lang: 'js',   dark: '#1c1407' },
  jsx:  { lab: 'JSX',  c: 'oklch(74% .14 88)',  lang: 'js',   dark: '#1c1407' },
  mjs:  { lab: 'JS',   c: 'oklch(74% .14 88)',  lang: 'js',   dark: '#1c1407' },
  css:  { lab: 'CSS',  c: 'oklch(60% .14 232)', lang: 'css' },
  scss: { lab: 'SCSS', c: 'oklch(58% .15 350)', lang: 'css' },
  go:   { lab: 'GO',   c: 'oklch(66% .12 205)', lang: 'go',   dark: '#04141a' },
  java: { lab: 'JV',   c: 'oklch(57% .16 35)',  lang: 'java' },
  json: { lab: '{}',   c: 'oklch(72% .12 95)',  lang: 'json', dark: '#1c1804' },
  md:   { lab: 'MD',   c: 'oklch(56% .02 250)', lang: 'md' },
  py:   { lab: 'PY',   c: 'oklch(56% .12 250)', lang: 'py' },
  rs:   { lab: 'RS',   c: 'oklch(60% .13 50)',  lang: 'rust', dark: '#1c1004' },
  html: { lab: '<>',   c: 'oklch(62% .16 42)',  lang: 'html' },
  sh:   { lab: 'SH',   c: 'oklch(58% .13 150)', lang: 'sh',   dark: '#04140a' },
  yml:  { lab: 'YML',  c: 'oklch(60% .14 320)', lang: 'yaml' },
  yaml: { lab: 'YML',  c: 'oklch(60% .14 320)', lang: 'yaml' },
  svg:  { lab: 'SVG',  c: 'oklch(62% .15 300)', lang: 'html' },
}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

// Split a path into its directory prefix (kept faint) and basename.
export function splitPath(path: string): { dir: string; file: string } {
  const i = path.lastIndexOf('/')
  return i >= 0 ? { dir: path.slice(0, i + 1), file: path.slice(i + 1) } : { dir: '', file: path }
}

export function FileIc({ name, big }: { name: string; big?: boolean }) {
  const l = LANG[extOf(name)]
  const bg = l ? l.c : 'oklch(50% .012 250)'           // unknown → neutral grey
  const color = l?.dark ?? '#fff'
  const ext = extOf(name)
  const lab = l ? l.lab : ext ? ext.slice(0, 3) : '·'  // unknown → first 3 chars (CSS uppercases)
  return (
    <span className={`fic${big ? ' pv-fic' : ''}`} style={{ background: bg, color }}>
      {lab}
    </span>
  )
}
