import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryRead, memoryWrite, memoryClear } from './memoryHandlers'
import { readSystemMemory, writeSystemMemory } from '../chat/memory/memoryStore'
import { readSessions } from '../chat/sessionStore'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'memh-')); writeSystemMemory('') })
afterEach(() => { rmSync(ws, { recursive: true, force: true }); writeSystemMemory('') })

describe('memory handlers', () => {
  it('system: write → read → clear round-trip', () => {
    memoryWrite({ level: 'system', content: '## 偏好\n- 中文\n' })
    expect(memoryRead({ level: 'system' })).toContain('- 中文')
    memoryClear({ level: 'system' })
    expect(memoryRead({ level: 'system' })).toBe('')
    expect(readSystemMemory()).toBe('')
  })
  it('workspace: scoped by wsPath', () => {
    memoryWrite({ level: 'workspace', wsPath: ws, content: '## 建区目的\n- 做记忆\n' })
    expect(memoryRead({ level: 'workspace', wsPath: ws })).toContain('做记忆')
    memoryClear({ level: 'workspace', wsPath: ws })
    expect(memoryRead({ level: 'workspace', wsPath: ws })).toBe('')
  })
  it('session: read/write/clear the rolling summary', () => {
    const sid = readSessions(ws).sessions[0].id
    memoryWrite({ level: 'session', wsPath: ws, sessionId: sid, content: '摘要:做记忆功能' })
    expect(memoryRead({ level: 'session', wsPath: ws, sessionId: sid })).toBe('摘要:做记忆功能')
    memoryClear({ level: 'session', wsPath: ws, sessionId: sid })
    expect(memoryRead({ level: 'session', wsPath: ws, sessionId: sid })).toBe('')
  })
  it('missing scope returns empty and does not throw', () => {
    expect(memoryRead({ level: 'workspace' })).toBe('')
    expect(memoryRead({ level: 'session', wsPath: ws })).toBe('')
    expect(() => memoryWrite({ level: 'session', wsPath: ws, content: 'x' })).not.toThrow()
  })
})
