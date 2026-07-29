import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeDiskPreviewCache, previewKeepRels } from './previewCache'

let dir: string          // temp backgrounds dir (holds the rel files)
let idx: string          // temp index path

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mff-preview-'))
  idx = join(dir, 'preview-index.json')
})
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

// Create a fake stored background file <rel> inside the temp backgrounds dir so lookup's existence check passes.
function touchRel(rel: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, rel), 'x')
}

describe('previewCache', () => {
  it('lookup misses on an unknown key', () => {
    const c = makeDiskPreviewCache(idx, dir)
    expect(c.lookup('content/bg/ns01')).toBeNull()
  })

  it('record then lookup hits when the file exists on disk', () => {
    const c = makeDiskPreviewCache(idx, dir)
    touchRel('abcd1234.jpg')
    c.record('content/bg/ns01', 'abcd1234.jpg')
    expect(c.lookup('content/bg/ns01')).toBe('abcd1234.jpg')
  })

  it('lookup self-heals (returns null + forgets) when the cached file was GC-deleted', () => {
    const c = makeDiskPreviewCache(idx, dir)
    touchRel('gone.jpg')
    c.record('k', 'gone.jpg')
    rmSync(join(dir, 'gone.jpg'))               // simulate startup/pick GC wiping the thumbnail
    expect(c.lookup('k')).toBeNull()            // → caller re-fetches instead of pointing at a missing file
    // and the stale entry is dropped, so it no longer counts toward the GC keep-set
    expect(previewKeepRels(idx)).not.toContain('gone.jpg')
  })

  it('persists across instances (survives a restart)', () => {
    touchRel('h.jpg')
    makeDiskPreviewCache(idx, dir).record('k', 'h.jpg')
    // a fresh instance (new app session) loads the index from disk
    expect(makeDiskPreviewCache(idx, dir).lookup('k')).toBe('h.jpg')
  })

  it('does NOT persist the activation code — keys are the caller-supplied path, not the fetch URL', () => {
    touchRel('h.jpg')
    makeDiskPreviewCache(idx, dir).record('content/bg/ns01', 'h.jpg')
    const raw = readFileSync(idx, 'utf8')
    expect(raw).toContain('content/bg/ns01')
    expect(raw).not.toContain('key=')          // no ?key=<code> ever written to disk
  })

  it('previewKeepRels lists every cached rel (for the backgrounds GC keep-set)', () => {
    touchRel('a.jpg'); touchRel('b.jpg')
    const c = makeDiskPreviewCache(idx, dir)
    c.record('k1', 'a.jpg'); c.record('k2', 'b.jpg')
    expect(new Set(previewKeepRels(idx))).toEqual(new Set(['a.jpg', 'b.jpg']))
  })

  it('tolerates a missing/corrupt index file', () => {
    expect(previewKeepRels(join(dir, 'nope.json'))).toEqual([])
    writeFileSync(idx, 'not json{')
    expect(makeDiskPreviewCache(idx, dir).lookup('k')).toBeNull()
    expect(existsSync(idx)).toBe(true)
  })
})
