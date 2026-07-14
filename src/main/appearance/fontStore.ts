import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { sysFile } from '../config/paths'
import { fontCssUrls, fontFileUrl, type FontCatalogEntry } from '../../shared/fontCatalog'

// Downloaded fonts live under ~/.myFlowForge/fonts/<id>/, holding the woff2 subset files plus a
// rewritten font.css (its @font-face src points at forge-font:// instead of the CDN) and a meta.json.
// This keeps them OUT of the installer and off the OS font directory: they load into the app via the
// injected CSS + custom protocol, so nothing needs admin rights and uninstalling the app removes them.
export const FONT_SCHEME = 'forge-font'
export const fontsDir = (): string => sysFile('fonts')

// Ids come from our own catalog, but guard the on-disk path anyway.
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_')
}

// Every woff2 file a Fontsource stylesheet references as url(./files/<name>.woff2). Deduped — the same
// subset can appear for both woff2 and woff, and across nothing else here.
export function woff2FilesInCss(css: string): string[] {
  const out = new Set<string>()
  const re = /url\(\.\/files\/([^)]+\.woff2)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) out.add(m[1])
  return [...out]
}

// Rewrite a Fontsource stylesheet so it works offline against our protocol: drop the .woff fallback
// (we only fetch woff2) and repoint each woff2 url at forge-font://f/<id>/<name>. Files are stored
// flattened directly under <id>/, so the ./files/ prefix is removed.
export function rewriteFontCss(css: string, id: string): string {
  return css
    .replace(/,\s*url\(\.\/files\/[^)]+\.woff\)\s*format\((['"])woff\1\)/g, '')
    .replace(/url\(\.\/files\/([^)]+\.woff2)\)/g, (_m, name: string) => `url("${FONT_SCHEME}://f/${id}/${name}")`)
}

// A minimal fetch shape so callers can pass a proxy-aware fetch and tests can pass a fake.
export type FontFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>

export type DownloadedFont = { id: string; family: string; css: string }

// Download a catalog font end-to-end: fetch each weight's stylesheet, collect + download all woff2
// subsets, then persist the rewritten CSS + meta. onProgress(done, total) fires per file so the UI can
// show a real byte-agnostic progress bar (CJK fonts are ~100 files). Throws on any failed request; the
// partial dir is removed so a retry starts clean.
export async function downloadCatalogFont(
  entry: FontCatalogEntry,
  fetchImpl: FontFetch,
  onProgress?: (done: number, total: number) => void,
  baseDir: string = fontsDir(),
): Promise<DownloadedFont> {
  const id = safeId(entry.id)
  const dir = join(baseDir, id)
  try {
    const cssTexts: string[] = []
    const fileSet = new Set<string>()
    for (const url of fontCssUrls(entry)) {
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error(`字体样式下载失败(${res.status})`)
      const css = await res.text()
      cssTexts.push(css)
      for (const f of woff2FilesInCss(css)) fileSet.add(f)
    }
    const files = [...fileSet]
    if (files.length === 0) throw new Error('未找到可下载的字体文件')

    mkdirSync(dir, { recursive: true })
    let done = 0
    onProgress?.(0, files.length)
    for (const name of files) {
      const res = await fetchImpl(fontFileUrl(entry.id, name))
      if (!res.ok) throw new Error(`字体文件下载失败(${res.status})`)
      writeFileSync(join(dir, name), Buffer.from(await res.arrayBuffer()))
      done++
      onProgress?.(done, files.length)
    }
    const css = cssTexts.map(c => rewriteFontCss(c, id)).join('\n')
    writeFileSync(join(dir, 'font.css'), css, 'utf8')
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, family: entry.family }), 'utf8')
    return { id, family: entry.family, css }
  } catch (e) {
    // Leave no half-downloaded font behind — it would inject broken @font-face rules on next launch.
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    throw e
  }
}

// Every fully-downloaded font (has both meta.json and font.css). Incomplete dirs are skipped.
export function listDownloadedFonts(baseDir: string = fontsDir()): DownloadedFont[] {
  let entries: string[]
  try { entries = readdirSync(baseDir) } catch { return [] }
  const out: DownloadedFont[] = []
  for (const id of entries) {
    const dir = join(baseDir, id)
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { family?: string }
      const css = readFileSync(join(dir, 'font.css'), 'utf8')
      out.push({ id, family: meta.family ?? id, css })
    } catch { /* not a complete font dir — skip */ }
  }
  return out
}

export function deleteDownloadedFont(id: string, baseDir: string = fontsDir()): boolean {
  const dir = resolveFontFileAbs(safeId(id), baseDir)
  if (!dir) return false
  try { rmSync(dir, { recursive: true, force: true }); return true } catch { return false }
}

// Resolve a stored relative path ("<id>/<name>.woff2" or "<id>") to an absolute path INSIDE fonts/,
// or null if it would escape (path-traversal guard for the protocol handler + delete).
export function resolveFontFileAbs(rel: string, baseDir: string = fontsDir()): string | null {
  const root = resolve(baseDir)
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}
