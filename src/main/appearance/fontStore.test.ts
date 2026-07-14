import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  woff2FilesInCss,
  rewriteFontCss,
  downloadCatalogFont,
  listDownloadedFonts,
  deleteDownloadedFont,
  resolveFontFileAbs,
  type FontFetch,
} from './fontStore'
import type { FontCatalogEntry } from '../../shared/fontCatalog'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fontstore-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

// A Fontsource-shaped stylesheet fragment: two subsets, each with woff2 + woff.
const CSS = `
@font-face {
  font-family: 'Demo';
  src: url(./files/demo-latin-400-normal.woff2) format('woff2'), url(./files/demo-latin-400-normal.woff) format('woff');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Demo';
  src: url(./files/demo-cyrillic-400-normal.woff2) format('woff2'), url(./files/demo-cyrillic-400-normal.woff) format('woff');
}
`

describe('woff2FilesInCss', () => {
  it('extracts only the woff2 files, deduped', () => {
    expect(woff2FilesInCss(CSS).sort()).toEqual(['demo-cyrillic-400-normal.woff2', 'demo-latin-400-normal.woff2'])
  })
})

describe('rewriteFontCss', () => {
  it('drops the woff fallback and repoints woff2 at forge-font://', () => {
    const out = rewriteFontCss(CSS, 'demo')
    expect(out).toContain('url("forge-font://f/demo/demo-latin-400-normal.woff2")')
    expect(out).not.toContain('.woff)') // the woff fallback is gone
    expect(out).not.toContain('./files/')
  })
})

const entry: FontCatalogEntry = {
  id: 'demo', family: 'Demo', label: 'Demo', category: 'sans', cjk: false, license: 'OFL-1.1', weights: [400], approxBytes: 1000,
}

// Fake fetch: the .css URL returns CSS, any .woff2 URL returns bytes, everything else 404s.
const fakeFetch: FontFetch = async (url: string) => {
  if (url.endsWith('.css')) return { ok: true, status: 200, text: async () => CSS, arrayBuffer: async () => new ArrayBuffer(0) }
  if (url.endsWith('.woff2')) return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
  return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
}

describe('downloadCatalogFont', () => {
  it('downloads every woff2, writes rewritten css + meta, and reports progress', async () => {
    const seen: Array<[number, number]> = []
    const font = await downloadCatalogFont(entry, fakeFetch, (d, t) => seen.push([d, t]), dir)
    expect(font.family).toBe('Demo')
    expect(existsSync(join(dir, 'demo', 'demo-latin-400-normal.woff2'))).toBe(true)
    expect(existsSync(join(dir, 'demo', 'demo-cyrillic-400-normal.woff2'))).toBe(true)
    expect(readFileSync(join(dir, 'demo', 'font.css'), 'utf8')).toContain('forge-font://f/demo/')
    expect(JSON.parse(readFileSync(join(dir, 'demo', 'meta.json'), 'utf8'))).toEqual({ id: 'demo', family: 'Demo' })
    expect(seen[seen.length - 1]).toEqual([2, 2]) // both files done
  })
  it('removes the partial dir and throws when a file download fails', async () => {
    const failing: FontFetch = async (url: string) =>
      url.endsWith('.css') ? { ok: true, status: 200, text: async () => CSS, arrayBuffer: async () => new ArrayBuffer(0) }
                           : { ok: false, status: 500, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    await expect(downloadCatalogFont(entry, failing, undefined, dir)).rejects.toThrow()
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })
})

describe('listDownloadedFonts / deleteDownloadedFont', () => {
  it('lists complete font dirs and deletes them', async () => {
    await downloadCatalogFont(entry, fakeFetch, undefined, dir)
    const list = listDownloadedFonts(dir)
    expect(list.map(f => f.id)).toEqual(['demo'])
    expect(list[0].css).toContain('forge-font://')
    expect(deleteDownloadedFont('demo', dir)).toBe(true)
    expect(listDownloadedFonts(dir)).toEqual([])
  })
  it('skips incomplete dirs (missing meta/css)', () => {
    mkdirSync(join(dir, 'half'), { recursive: true })
    writeFileSync(join(dir, 'half', 'font.css'), 'x')
    expect(listDownloadedFonts(dir)).toEqual([])
  })
})

describe('resolveFontFileAbs', () => {
  it('resolves inside the dir and blocks traversal', () => {
    expect(resolveFontFileAbs('demo/a.woff2', dir)).toBe(join(dir, 'demo', 'a.woff2'))
    expect(resolveFontFileAbs('../escape', dir)).toBeNull()
  })
})
