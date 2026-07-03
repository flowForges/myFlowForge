import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { continueFrom, getSession } from './sessionStore'

describe('getSession', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forge-gs-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns a continued session carrying continuedFrom', () => {
    const f = continueFrom(dir, { source: 'claude', externalId: 'abc', title: 't', filePaths: ['/x.jsonl'] })
    const sid = f.activeSessionId
    const s = getSession(dir, sid)
    expect(s?.continuedFrom?.externalId).toBe('abc')
    expect(s?.continuedFrom?.source).toBe('claude')
  })
})
