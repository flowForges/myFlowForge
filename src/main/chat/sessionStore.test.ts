import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessions, newSession, switchSession, closeSession, renameSession, setSessionMode } from './sessionStore'
import { readMessages } from './chatStore'

let ws: string
const forge = () => join(ws, '.forge')
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'sess-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('sessionStore', () => {
  it('fresh workspace gets one empty 新会话 as active', () => {
    const f = readSessions(ws)
    expect(f.sessions).toHaveLength(1)
    expect(f.sessions[0].title).toBe('新会话')
    expect(f.activeSessionId).toBe(f.sessions[0].id)
  })
  it('migrates legacy chat.jsonl into a default session (title from first user msg)', () => {
    mkdirSync(forge(), { recursive: true })
    appendFileSync(join(forge(), 'chat.jsonl'), JSON.stringify({ id: '1', who: 'user', text: '帮我迁移颜色 token 到 OKLch 并补测试', ts: '00:00:00' }) + '\n')
    appendFileSync(join(forge(), 'chat.jsonl'), JSON.stringify({ id: '2', who: 'ai', text: '好的', ts: '00:00:01' }) + '\n')
    writeFileSync(join(forge(), 'chat-session.json'), JSON.stringify({ claude: 'r-old' }))
    const f = readSessions(ws)
    expect(f.sessions).toHaveLength(1)
    const sid = f.sessions[0].id
    expect(f.sessions[0].title.startsWith('帮我迁移颜色 token')).toBe(true)
    // messages moved under the new session
    expect(readMessages(ws, sid).map(m => m.id)).toEqual(['1', '2'])
    // legacy resume map nested under the session
    const resume = JSON.parse(readFileSync(join(forge(), 'chat-session.json'), 'utf8'))
    expect(resume[sid].claude).toBe('r-old')
    // legacy chat.jsonl consumed
    expect(existsSync(join(forge(), 'chat.jsonl'))).toBe(false)
    // idempotent: second read returns same session
    expect(readSessions(ws).sessions[0].id).toBe(sid)
  })
  it('newSession appends and activates', () => {
    const a = readSessions(ws).sessions[0].id
    const f = newSession(ws)
    expect(f.sessions).toHaveLength(2)
    expect(f.activeSessionId).not.toBe(a)
    expect(f.sessions[f.sessions.length - 1].title).toBe('新会话')
  })
  it('switchSession sets active; ignores unknown id', () => {
    const f0 = newSession(ws)
    const first = f0.sessions[0].id
    expect(switchSession(ws, first).activeSessionId).toBe(first)
    expect(switchSession(ws, 'nope').activeSessionId).toBe(first)
  })
  it('closeSession removes + reassigns active; refuses to close the last one', () => {
    const f1 = newSession(ws)          // now 2 sessions, 2nd active
    const active = f1.activeSessionId
    const f2 = closeSession(ws, active)
    expect(f2.sessions).toHaveLength(1)
    expect(f2.activeSessionId).toBe(f2.sessions[0].id)
    const f3 = closeSession(ws, f2.sessions[0].id)   // last one — refuse
    expect(f3.sessions).toHaveLength(1)
  })
  it('renameSession + setSessionMode persist', () => {
    const sid = readSessions(ws).sessions[0].id
    expect(renameSession(ws, sid, 'OKLch 迁移').sessions[0].title).toBe('OKLch 迁移')
    const f = setSessionMode(ws, sid, 'workflow', 'run-7')
    expect(f.sessions[0].mode).toBe('workflow')
    expect(f.sessions[0].runId).toBe('run-7')
  })
})
