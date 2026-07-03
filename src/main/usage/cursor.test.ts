import { describe, it, expect } from 'vitest'
import { normalizeCursor, readCursorToken } from './cursor'

const NOW = 1_700_000_000_000

describe('normalizeCursor', () => {
  it('maps plan usage percent + billing reset', () => {
    const u = normalizeCursor({ used_percent: 12, resets_at: 1_700_600_000 }, NOW)
    expect(u.window5h).toEqual({ used: 12, limit: 100, resetAt: 1_700_600_000_000 })
    expect(u.label).toBe('Cursor')
  })
  it('returns undefined window5h (no throw) when given empty object', () => {
    const u = normalizeCursor({}, NOW)
    expect(u.window5h).toBeUndefined()
    expect(u.label).toBe('Cursor')
  })
})

describe('readCursorToken', () => {
  it('returns token from injected sqlite reader', () => {
    const t = readCursorToken({ home: '/h', runSqlite: (db) => { expect(db).toContain('state.vscdb'); return 'CURSOR_TOK' } })
    expect(t).toBe('CURSOR_TOK')
  })
  it('throws when reader returns empty', () => {
    expect(() => readCursorToken({ home: '/h', runSqlite: () => '' })).toThrow(/Cursor 未登录/)
  })
})
