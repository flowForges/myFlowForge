import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMessage, readMessages, readSession, writeSession, sessionMessagesFile } from './chatStore'
import type { ChatMessage } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'chat-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const msg = (id: string, who: 'user' | 'ai', text: string): ChatMessage => ({ id, who, text, ts: '00:00:00' })

describe('chatStore (session-aware)', () => {
  it('appends/reads messages scoped to a session', () => {
    expect(readMessages(ws, 's1')).toEqual([])
    appendMessage(ws, 's1', msg('1', 'user', 'hi'))
    appendMessage(ws, 's2', msg('2', 'user', 'other'))
    expect(readMessages(ws, 's1').map(m => m.id)).toEqual(['1'])
    expect(readMessages(ws, 's2').map(m => m.id)).toEqual(['2'])
  })
  it('messages land under .forge/sessions/<id>.jsonl', () => {
    appendMessage(ws, 's1', msg('1', 'user', 'hi'))
    expect(existsSync(sessionMessagesFile(ws, 's1'))).toBe(true)
  })
  it('reads/writes per-session per-agent resume id', () => {
    expect(readSession(ws, 's1', 'claude')).toBeUndefined()
    writeSession(ws, 's1', 'claude', 'r-a')
    writeSession(ws, 's2', 'claude', 'r-b')
    expect(readSession(ws, 's1', 'claude')).toBe('r-a')
    expect(readSession(ws, 's2', 'claude')).toBe('r-b')
  })
  it('tolerates missing dir and skips corrupt lines', () => {
    expect(readMessages(join(ws, 'nope'), 's1')).toEqual([])
    appendMessage(ws, 's1', msg('1', 'user', 'hi'))
    appendFileSync(sessionMessagesFile(ws, 's1'), 'not-json\n')
    appendMessage(ws, 's1', msg('2', 'ai', 'hello'))
    expect(readMessages(ws, 's1').map(m => m.id)).toEqual(['1', '2'])
  })
})
