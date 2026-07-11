import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMessage, readMessages, readSession, writeSession, sessionMessagesFile, readWatermark, writeWatermark } from './chatStore'
import { wsForgeDir } from '../config/paths'
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

  describe('per-provider watermark', () => {
    const resumeFilePath = (wsPath: string) => join(wsForgeDir(wsPath), 'chat-session.json')

    it('defaults to 0 when absent', () => {
      expect(readWatermark(ws, 's1', 'claude')).toBe(0)
    })

    it('round-trips a written watermark', () => {
      writeWatermark(ws, 's1', 'claude', 7)
      expect(readWatermark(ws, 's1', 'claude')).toBe(7)
      writeWatermark(ws, 's1', 'claude', 12)
      expect(readWatermark(ws, 's1', 'claude')).toBe(12)
    })

    it('writing a watermark does not clobber an existing resumeId', () => {
      writeSession(ws, 's1', 'claude', 'r-a')
      writeWatermark(ws, 's1', 'claude', 3)
      expect(readSession(ws, 's1', 'claude')).toBe('r-a')
      expect(readWatermark(ws, 's1', 'claude')).toBe(3)
    })

    it('writing a resumeId does not clobber an existing watermark', () => {
      writeWatermark(ws, 's1', 'claude', 5)
      writeSession(ws, 's1', 'claude', 'r-b')
      expect(readWatermark(ws, 's1', 'claude')).toBe(5)
      expect(readSession(ws, 's1', 'claude')).toBe('r-b')
    })

    it('reads a legacy bare-string resume entry via readSession, and readWatermark defaults to 0', () => {
      writeSession(ws, 's1', 'claude', 'legacy-id') // ensures dir exists
      // Overwrite on-disk file with the OLD shape: { [sessionId]: { [agent]: resumeId } } (bare string).
      writeFileSync(resumeFilePath(ws), JSON.stringify({ s1: { claude: 'legacy-id' } }, null, 2))
      expect(readSession(ws, 's1', 'claude')).toBe('legacy-id')
      expect(readWatermark(ws, 's1', 'claude')).toBe(0)
    })
  })
})
