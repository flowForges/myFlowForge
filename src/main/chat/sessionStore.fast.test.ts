import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessions, newSession, setSessionFast } from './sessionStore'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'fast-store-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('会话的 codex 快速档落盘', () => {
  it('没设置过时字段不存在 —— 等于关', () => {
    expect(newSession(ws).sessions[0].fast).toBeUndefined()
  })

  it('设置后能读回来,且只影响目标会话', () => {
    const a = newSession(ws).activeSessionId
    const b = newSession(ws).activeSessionId
    setSessionFast(ws, a, true)
    const f = readSessions(ws)
    expect(f.sessions.find(s => s.id === a)!.fast).toBe(true)
    expect(f.sessions.find(s => s.id === b)!.fast).toBeUndefined()
  })

  it('能关回去,false 真的落盘', () => {
    const id = newSession(ws).activeSessionId
    setSessionFast(ws, id, true)
    setSessionFast(ws, id, false)
    expect(readSessions(ws).sessions.find(s => s.id === id)!.fast).toBe(false)
  })

  it('会话 id 不存在时不炸,也不凭空造一条', () => {
    newSession(ws)
    const before = readSessions(ws).sessions.length
    expect(() => setSessionFast(ws, 'no-such-id', true)).not.toThrow()
    expect(readSessions(ws).sessions.length).toBe(before)
  })
})
