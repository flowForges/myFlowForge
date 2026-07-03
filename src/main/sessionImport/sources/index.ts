import type { DiscoveredSession, ImportedMessage } from '@shared/types'
import type { SourceRoots } from '../types'
import { defaultRoots } from '../types'
import { claudeSource, type SessionSource } from './claude'
import { codexSource } from './codex'
import { cursorSource } from './cursor'
import { qoderSource } from './qoder'

export const SOURCES: SessionSource[] = [claudeSource, codexSource, cursorSource, qoderSource]

export function scanAll(roots: SourceRoots = defaultRoots()): DiscoveredSession[] {
  const out: DiscoveredSession[] = []
  for (const src of SOURCES) {
    try { out.push(...src.scan(roots)) } catch { /* isolate a failing source */ }
  }
  return out
}

export function readSession(s: DiscoveredSession): ImportedMessage[] {
  const src = SOURCES.find(x => x.id === s.source)
  if (!src) return []
  try { return src.readMessages(s) } catch { return [] }
}
