import { existsSync, readFileSync } from 'node:fs'
import type { ScanCache, SessionGroup } from '@shared/types'
import { sysFile } from '../config/paths'
import { writeJsonAtomic } from '../util/atomicWrite'

export function scanCacheFile(): string { return sysFile('last-scan.json') }

export function readScanCache(file = scanCacheFile()): ScanCache | null {
  try {
    if (!existsSync(file)) return null
    const o = JSON.parse(readFileSync(file, 'utf8'))
    if (o && Array.isArray(o.groups) && typeof o.scannedAt === 'number') {
      return { version: 1, scannedAt: o.scannedAt, groups: o.groups }
    }
    return null
  } catch { return null }
}

export function writeScanCache(groups: SessionGroup[], scannedAt: number, file = scanCacheFile()): void {
  writeJsonAtomic(file, { version: 1, scannedAt, groups })
}
