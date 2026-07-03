import { existsSync, readFileSync } from 'node:fs'
import type { DiscoveredSession, ImportedIndex } from '@shared/types'
import { sysFile } from '../config/paths'
import { writeJsonAtomic } from '../util/atomicWrite'

export function importIndexFile(): string { return sysFile('imported-sessions.json') }

const EMPTY: ImportedIndex = { version: 1, scannedAt: 0, sessions: [] }

export function readIndex(file = importIndexFile()): ImportedIndex {
  try {
    if (!existsSync(file)) return { ...EMPTY }
    const o = JSON.parse(readFileSync(file, 'utf8'))
    if (o && Array.isArray(o.sessions)) return { version: 1, scannedAt: o.scannedAt ?? 0, sessions: o.sessions }
    return { ...EMPTY }
  } catch { return { ...EMPTY } }
}

export function upsertSessions(sessions: DiscoveredSession[], scannedAt: number, file = importIndexFile()): ImportedIndex {
  const idx = readIndex(file)
  const key = (s: DiscoveredSession) => `${s.source}::${s.externalId}`
  const map = new Map(idx.sessions.map(s => [key(s), s]))
  for (const s of sessions) map.set(key(s), s)
  const next: ImportedIndex = { version: 1, scannedAt, sessions: [...map.values()] }
  writeJsonAtomic(file, next)
  return next
}

export function removeImportedCwd(cwd: string, file = importIndexFile()): void {
  const idx = readIndex(file)
  writeJsonAtomic(file, { ...idx, sessions: idx.sessions.filter(s => s.cwd !== cwd) })
}
