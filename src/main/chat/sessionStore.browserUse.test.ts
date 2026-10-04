import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessions, newSession, setSessionBrowserUse } from './sessionStore'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'bu-store-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('会话的浏览器开关落盘', () => {
  it('没设置过时字段不存在 —— 读的人按默认值 off 处理', () => {
    const f = newSession(ws)
    expect(f.sessions[0].browserUse).toBeUndefined()
  })

  it('设置后能读回来,且只影响目标会话', () => {
    const a = newSession(ws).activeSessionId
    const b = newSession(ws).activeSessionId
    setSessionBrowserUse(ws, a, 'ask')
    const f = readSessions(ws)
    expect(f.sessions.find(s => s.id === a)!.browserUse).toBe('ask')
    expect(f.sessions.find(s => s.id === b)!.browserUse).toBeUndefined()
  })

  it('能改回 off(关掉之后要真的留在磁盘上,不能悄悄回到未设置)', () => {
    const id = newSession(ws).activeSessionId
    setSessionBrowserUse(ws, id, 'allow')
    setSessionBrowserUse(ws, id, 'off')
    expect(readSessions(ws).sessions.find(s => s.id === id)!.browserUse).toBe('off')
  })

  it('会话 id 不存在时不炸,也不凭空造一条', () => {
    newSession(ws)
    const before = readSessions(ws).sessions.length
    expect(() => setSessionBrowserUse(ws, 'no-such-id', 'ask')).not.toThrow()
    expect(readSessions(ws).sessions.length).toBe(before)
  })
})
