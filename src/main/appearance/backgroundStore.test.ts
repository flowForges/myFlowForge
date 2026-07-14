import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  storeBackgroundFromPath,
  resolveBackgroundAbs,
  bgRelFromUrl,
  gcBackgrounds,
  backgroundImageUrl,
  MAX_BG_BYTES,
} from './backgroundStore'

let dir: string
let src: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bgstore-'))
  src = mkdtempSync(join(tmpdir(), 'bgsrc-'))
})
afterEach(() => {
  for (const d of [dir, src]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

const writeSrc = (name: string, content: string | Buffer): string => {
  const p = join(src, name)
  writeFileSync(p, content)
  return p
}

describe('storeBackgroundFromPath', () => {
  it('copies the file under a content-addressed <hash>.<ext> name', () => {
    const r = storeBackgroundFromPath(writeSrc('pic.png', 'hello-bytes'), dir)
    expect('rel' in r).toBe(true)
    if ('rel' in r) {
      expect(r.rel).toMatch(/^[a-f0-9]{16}\.png$/)
      expect(existsSync(join(dir, r.rel))).toBe(true)
      expect(readFileSync(join(dir, r.rel)).toString()).toBe('hello-bytes')
    }
  })
  it('dedupes identical bytes to the same file, distinct bytes to different files', () => {
    const a = storeBackgroundFromPath(writeSrc('a.png', 'same'), dir)
    const b = storeBackgroundFromPath(writeSrc('b.png', 'same'), dir)
    const c = storeBackgroundFromPath(writeSrc('c.png', 'different'), dir)
    if ('rel' in a && 'rel' in b && 'rel' in c) {
      expect(b.rel).toBe(a.rel)
      expect(c.rel).not.toBe(a.rel)
      expect(readdirSync(dir).length).toBe(2)
    } else { throw new Error('expected all stores to succeed') }
  })
  it('normalizes jpeg → jpg extension', () => {
    const r = storeBackgroundFromPath(writeSrc('photo.jpeg', 'x'), dir)
    if ('rel' in r) expect(r.rel.endsWith('.jpg')).toBe(true)
    else throw new Error('expected success')
  })
  it('rejects unsupported formats', () => {
    const r = storeBackgroundFromPath(writeSrc('doc.pdf', 'x'), dir)
    expect('error' in r).toBe(true)
  })
  it('rejects oversized files', () => {
    const r = storeBackgroundFromPath(writeSrc('big.png', Buffer.alloc(MAX_BG_BYTES + 1)), dir)
    expect('error' in r).toBe(true)
  })
  it('returns an error for a missing source path', () => {
    expect('error' in storeBackgroundFromPath(join(src, 'nope.png'), dir)).toBe(true)
  })
})

describe('resolveBackgroundAbs', () => {
  it('resolves a rel path inside the dir', () => {
    expect(resolveBackgroundAbs('abc.png', dir)).toBe(join(dir, 'abc.png'))
  })
  it('blocks path traversal escaping the dir', () => {
    expect(resolveBackgroundAbs('../evil.png', dir)).toBeNull()
  })
})

describe('bgRelFromUrl', () => {
  it('extracts the rel path from a forge-bg:// url', () => {
    expect(bgRelFromUrl('forge-bg://img/deadbeef.png')).toBe('deadbeef.png')
  })
  it('returns null for legacy data URLs, empty, and undefined', () => {
    expect(bgRelFromUrl('data:image/png;base64,AAAA')).toBeNull()
    expect(bgRelFromUrl('')).toBeNull()
    expect(bgRelFromUrl(undefined)).toBeNull()
  })
})

describe('backgroundImageUrl', () => {
  it('round-trips with bgRelFromUrl', () => {
    expect(bgRelFromUrl(backgroundImageUrl('cafe1234.gif'))).toBe('cafe1234.gif')
  })
})

describe('gcBackgrounds', () => {
  it('deletes files not in the keep set, preserving referenced ones', () => {
    const keep = storeBackgroundFromPath(writeSrc('keep.png', 'keep'), dir)
    const drop = storeBackgroundFromPath(writeSrc('drop.png', 'drop'), dir)
    if (!('rel' in keep) || !('rel' in drop)) throw new Error('setup failed')
    const removed = gcBackgrounds(new Set([keep.rel]), dir)
    expect(removed).toBe(1)
    expect(existsSync(join(dir, keep.rel))).toBe(true)
    expect(existsSync(join(dir, drop.rel))).toBe(false)
  })
  it('returns 0 for a missing dir', () => {
    expect(gcBackgrounds(new Set(), join(dir, 'does-not-exist'))).toBe(0)
  })
})
