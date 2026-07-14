import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distillSession, promoteToWorkspace, promoteToSystem } from './distiller'
import { readWorkspaceMemory, writeWorkspaceMemory, readSystemMemory, writeSystemMemory } from './memoryStore'
import { readSessions } from '../sessionStore'
import { appendMessage } from '../chatStore'
import type { ChatMessage } from '@shared/types'

let ws: string
const msg = (id: string, who: 'user' | 'ai', text: string): ChatMessage => ({ id, who, text, ts: '00:00:00' })
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'distill-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('distillSession', () => {
  it('summarizes the session and writes summary onto the session (fail-open path not hit)', async () => {
    const sid = readSessions(ws).sessions[0].id
    appendMessage(ws, sid, msg('1', 'user', '迁移颜色 token 到 OKLch'))
    appendMessage(ws, sid, msg('2', 'ai', '好的,分层 token'))
    const oneShot = vi.fn().mockResolvedValue('摘要:用户在做 OKLch 迁移,方案=分层 token')
    await distillSession(ws, sid, { oneShot })
    expect(oneShot).toHaveBeenCalledTimes(1)
    expect(readSessions(ws).sessions[0].summary).toBe('摘要:用户在做 OKLch 迁移,方案=分层 token')
  })
  it('fail-open: LLM throws → summary unchanged, no throw', async () => {
    const sid = readSessions(ws).sessions[0].id
    appendMessage(ws, sid, msg('1', 'user', 'hi'))
    const oneShot = vi.fn().mockRejectedValue(new Error('llm down'))
    await expect(distillSession(ws, sid, { oneShot })).resolves.toBeUndefined()
    expect(readSessions(ws).sessions[0].summary).toBeUndefined()
  })
  it('no-op for an empty session (no LLM call)', async () => {
    const sid = readSessions(ws).sessions[0].id
    const oneShot = vi.fn()
    await distillSession(ws, sid, { oneShot })
    expect(oneShot).not.toHaveBeenCalled()
  })
})

describe('promoteToWorkspace', () => {
  it('distills durable facts and merges into workspace.md', async () => {
    const sid = readSessions(ws).sessions[0].id
    appendMessage(ws, sid, msg('1', 'user', '我们统一用 vitest 跑测试'))
    const oneShot = vi.fn().mockResolvedValue('## 约定\n- 统一用 vitest 跑测试\n')
    await promoteToWorkspace(ws, sid, { oneShot })
    expect(readWorkspaceMemory(ws)).toContain('- 统一用 vitest 跑测试')
  })
  it('fail-open: LLM throws → workspace.md unchanged', async () => {
    const sid = readSessions(ws).sessions[0].id
    appendMessage(ws, sid, msg('1', 'user', 'x'))
    writeWorkspaceMemory(ws, '## 架构\n- 既有\n')
    const oneShot = vi.fn().mockRejectedValue(new Error('boom'))
    await promoteToWorkspace(ws, sid, { oneShot })
    expect(readWorkspaceMemory(ws)).toBe('## 架构\n- 既有\n')
  })
  it('blank distill output leaves workspace.md unchanged', async () => {
    const sid = readSessions(ws).sessions[0].id
    appendMessage(ws, sid, msg('1', 'user', 'x'))
    writeWorkspaceMemory(ws, '## 架构\n- 既有\n')
    const oneShot = vi.fn().mockResolvedValue('   ')
    await promoteToWorkspace(ws, sid, { oneShot })
    expect(readWorkspaceMemory(ws)).toBe('## 架构\n- 既有\n')
  })
  it('prompt asks for project / relationship / purpose sections', async () => {
    const sid = readSessions(ws).sessions[0].id
    appendMessage(ws, sid, msg('1', 'user', 'x'))
    let captured = ''
    const oneShot = vi.fn().mockImplementation(async (p: string) => { captured = p; return '' })
    await promoteToWorkspace(ws, sid, { oneShot })
    expect(captured).toContain('## 项目')
    expect(captured).toContain('## 项目关系')
    expect(captured).toContain('## 建区目的')
  })
})

describe('promoteToSystem', () => {
  it('distills cross-workspace prefs and merges into system.md', async () => {
    writeSystemMemory('')
    writeWorkspaceMemory(ws, '## 约定\n- 统一用 vitest\n')
    const oneShot = vi.fn().mockResolvedValue('## 偏好\n- 中文回复,代码英文\n')
    await promoteToSystem(ws, { oneShot })
    expect(readSystemMemory()).toContain('- 中文回复,代码英文')
    writeSystemMemory('')
  })
  it('fail-open: LLM throws → system.md unchanged', async () => {
    writeSystemMemory('## 偏好\n- 既有\n')
    writeWorkspaceMemory(ws, '## 约定\n- x\n')
    const oneShot = vi.fn().mockRejectedValue(new Error('boom'))
    await promoteToSystem(ws, { oneShot })
    expect(readSystemMemory()).toBe('## 偏好\n- 既有\n')
    writeSystemMemory('')
  })
  it('prompt asks for user-habit + capability sections', async () => {
    writeSystemMemory('')
    writeWorkspaceMemory(ws, '## 约定\n- 统一用 vitest\n')
    let captured = ''
    const oneShot = vi.fn().mockImplementation(async (p: string) => { captured = p; return '' })
    await promoteToSystem(ws, { oneShot })
    expect(captured).toContain('## 用户习惯')
    expect(captured).toContain('## 常用能力')
    writeSystemMemory('')
  })
})
