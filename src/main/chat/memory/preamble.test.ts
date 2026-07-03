import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMemoryPreamble } from './preamble'
import { writeWorkspaceMemory, writeSystemMemory } from './memoryStore'
import { readSessions, setSessionSummary } from '../sessionStore'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'pre-')); writeSystemMemory('') })
afterEach(() => { rmSync(ws, { recursive: true, force: true }); writeSystemMemory('') })

describe('buildMemoryPreamble', () => {
  it('returns empty when no memory anywhere and not gapped', () => {
    const sid = readSessions(ws).sessions[0].id
    expect(buildMemoryPreamble(ws, sid, { resumeGapped: false })).toBe('')
  })
  it('orders system + workspace, omits session summary unless gapped', () => {
    writeSystemMemory('## 偏好\n- 中文\n')
    writeWorkspaceMemory(ws, '## 架构\n- 单仓多 worktree\n')
    const sid = readSessions(ws).sessions[0].id
    setSessionSummary(ws, sid, '本会话:OKLch 迁移')
    const noGap = buildMemoryPreamble(ws, sid, { resumeGapped: false })
    expect(noGap.indexOf('## 偏好')).toBeLessThan(noGap.indexOf('## 架构'))
    expect(noGap).not.toContain('OKLch 迁移')
    const gapped = buildMemoryPreamble(ws, sid, { resumeGapped: true })
    expect(gapped).toContain('OKLch 迁移')
    expect(gapped.indexOf('## 架构')).toBeLessThan(gapped.indexOf('OKLch 迁移'))
  })
  it('wraps in a clear delimiter block', () => {
    writeSystemMemory('## 偏好\n- 中文\n')
    const sid = readSessions(ws).sessions[0].id
    const p = buildMemoryPreamble(ws, sid, { resumeGapped: false })
    expect(p).toContain('# 记忆上下文')
    expect(p.endsWith('\n')).toBe(true)
  })
})
