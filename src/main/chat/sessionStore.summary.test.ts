import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessions, setSessionSummary } from './sessionStore'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'sess-sum-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('sessionStore.setSessionSummary', () => {
  it('writes a rolling summary onto the session and persists it', () => {
    const sid = readSessions(ws).sessions[0].id
    expect(readSessions(ws).sessions[0].summary).toBeUndefined()
    const f = setSessionSummary(ws, sid, '用户在做 OKLch 颜色迁移;已定方案=分层 token')
    expect(f.sessions[0].summary).toBe('用户在做 OKLch 颜色迁移;已定方案=分层 token')
    // persisted across reads
    expect(readSessions(ws).sessions[0].summary).toBe('用户在做 OKLch 颜色迁移;已定方案=分层 token')
  })
  it('ignores an unknown session id', () => {
    const before = readSessions(ws)
    const after = setSessionSummary(ws, 'nope', 'x')
    expect(after.sessions[0].summary).toBeUndefined()
    expect(after.sessions.length).toBe(before.sessions.length)
  })
})
