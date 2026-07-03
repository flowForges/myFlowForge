import { describe, it, expect } from 'vitest'
import { join, sep } from 'node:path'
import { searchContentFs, type SearchFs, type FileEntry } from './contentSearch'

// In-memory fake fs. Files is a map of forward-slashed relative path -> content (string or Buffer).
// Directories are inferred from the path prefixes.
function fakeFs(root: string, files: Record<string, string | Buffer>): SearchFs {
  const norm = (p: string) => p.split(sep).join('/')
  const rel = (abs: string) => {
    const a = norm(abs), r = norm(root)
    return a === r ? '' : a.startsWith(r + '/') ? a.slice(r.length + 1) : a
  }
  const bufOf = (v: string | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'))
  return {
    readdir(dir): FileEntry[] {
      const base = rel(dir)
      const prefix = base ? base + '/' : ''
      const names = new Set<string>()
      const dirs = new Set<string>()
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) names.add(rest)
        else dirs.add(rest.slice(0, slash))
      }
      const out: FileEntry[] = []
      for (const d of dirs) out.push({ name: d, isDirectory: () => true, isFile: () => false })
      for (const n of names) out.push({ name: n, isDirectory: () => false, isFile: () => true })
      return out
    },
    readFile(path) {
      const v = files[rel(path)]
      if (v === undefined) throw new Error('ENOENT ' + path)
      return bufOf(v)
    },
    size(path) {
      const v = files[rel(path)]
      if (v === undefined) throw new Error('ENOENT ' + path)
      return bufOf(v).length
    },
  }
}

const ROOT = join('/', 'repo')

describe('searchContentFs', () => {
  it('finds a matching line with 1-based line number and trimmed preview', () => {
    const fs = fakeFs(ROOT, { 'a.ts': 'const x = 1\n  hello world\nconst y = 2\n' })
    const r = searchContentFs({ root: ROOT, query: 'hello' }, fs)
    expect(r.hits).toEqual([{ file: 'a.ts', line: 2, preview: 'hello world' }])
    expect(r.truncated).toBe(false)
  })

  it('returns no hits when nothing matches', () => {
    const fs = fakeFs(ROOT, { 'a.ts': 'nothing here\n' })
    expect(searchContentFs({ root: ROOT, query: 'zzz' }, fs).hits).toEqual([])
  })

  it('is case-insensitive', () => {
    const fs = fakeFs(ROOT, { 'a.ts': 'HeLLo THERE\n' })
    const r = searchContentFs({ root: ROOT, query: 'hello' }, fs)
    expect(r.hits.length).toBe(1)
  })

  it('empty query returns nothing (no full-file dump)', () => {
    const fs = fakeFs(ROOT, { 'a.ts': 'x\n' })
    expect(searchContentFs({ root: ROOT, query: '   ' }, fs).hits).toEqual([])
  })

  it('skips ignored directories (node_modules, .git)', () => {
    const fs = fakeFs(ROOT, {
      'src/a.ts': 'find me\n',
      'node_modules/pkg/b.ts': 'find me\n',
      '.git/config': 'find me\n',
    })
    const r = searchContentFs({ root: ROOT, query: 'find me' }, fs)
    expect(r.hits.map((h) => h.file)).toEqual(['src/a.ts'])
  })

  it('skips binary files (NUL byte)', () => {
    const fs = fakeFs(ROOT, {
      'a.ts': 'match here\n',
      'bin.dat': Buffer.from([0x6d, 0x00, 0x6d, 0x61, 0x74, 0x63, 0x68]), // contains NUL + "match"
    })
    const r = searchContentFs({ root: ROOT, query: 'match' }, fs)
    expect(r.hits.map((h) => h.file)).toEqual(['a.ts'])
  })

  it('skips files larger than maxFileBytes', () => {
    const big = 'match\n'.repeat(100)
    const fs = fakeFs(ROOT, { 'big.ts': big, 'small.ts': 'match\n' })
    const r = searchContentFs({ root: ROOT, query: 'match', maxFileBytes: 20 }, fs)
    expect(r.hits.map((h) => h.file)).toEqual(['small.ts'])
  })

  it('caps hits at maxHits and flags truncated', () => {
    const many = Array.from({ length: 50 }, () => 'match').join('\n') + '\n'
    const fs = fakeFs(ROOT, { 'a.ts': many })
    const r = searchContentFs({ root: ROOT, query: 'match', maxHits: 10 }, fs)
    expect(r.hits.length).toBe(10)
    expect(r.truncated).toBe(true)
  })

  it('truncates long line previews', () => {
    const long = 'x'.repeat(500) + 'match'
    const fs = fakeFs(ROOT, { 'a.ts': long + '\n' })
    const r = searchContentFs({ root: ROOT, query: 'match', previewMax: 50 }, fs)
    expect(r.hits[0].preview.length).toBe(51) // 50 + ellipsis
    expect(r.hits[0].preview.endsWith('…')).toBe(true)
  })

  it('searches only the given file subset when files[] provided', () => {
    const fs = fakeFs(ROOT, { 'a.ts': 'match\n', 'b.ts': 'match\n', 'c.ts': 'match\n' })
    const r = searchContentFs({ root: ROOT, query: 'match', files: ['a.ts', 'c.ts'] }, fs)
    expect(r.hits.map((h) => h.file)).toEqual(['a.ts', 'c.ts'])
  })
})
