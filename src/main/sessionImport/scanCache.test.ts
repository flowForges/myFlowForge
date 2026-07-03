import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readScanCache, writeScanCache } from './scanCache'

let f: string
beforeEach(() => { f = join(mkdtempSync(join(tmpdir(), 'sc-')), 'last-scan.json') })
afterEach(() => { rmSync(join(f, '..'), { recursive: true, force: true }) })

describe('scanCache', () => {
  it('往返读写', () => {
    writeScanCache([{ cwd: '/r', wsPath: '/r', matched: false, sessions: [] }], 123, f)
    const c = readScanCache(f)
    expect(c?.scannedAt).toBe(123)
    expect(c?.groups[0].cwd).toBe('/r')
  })
  it('缺失/损坏返回 null', () => {
    expect(readScanCache(f)).toBeNull()
    writeFileSync(f, 'not-json')
    expect(readScanCache(f)).toBeNull()
  })
})
