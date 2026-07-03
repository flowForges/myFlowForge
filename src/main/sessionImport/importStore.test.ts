import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIndex, upsertSessions } from './importStore'
import type { DiscoveredSession } from '@shared/types'

const s = (id: string, count: number): DiscoveredSession =>
  ({ source: 'claude', externalId: id, cwd: '/p', title: id, startedAt: 1, lastTs: 1, messageCount: count, filePaths: [], hasBody: true })

describe('importStore', () => {
  it('returns empty index when file missing', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'idx-')), 'imported-sessions.json')
    expect(readIndex(f)).toEqual({ version: 1, scannedAt: 0, sessions: [] })
  })
  it('upserts deduped by (source, externalId)', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'idx-')), 'imported-sessions.json')
    upsertSessions([s('a', 1)], 100, f)
    upsertSessions([s('a', 5), s('b', 1)], 200, f)   // 'a' updated, 'b' added
    const idx = readIndex(f)
    expect(idx.sessions).toHaveLength(2)
    expect(idx.sessions.find(x => x.externalId === 'a')!.messageCount).toBe(5)
    expect(idx.scannedAt).toBe(200)
  })
})
