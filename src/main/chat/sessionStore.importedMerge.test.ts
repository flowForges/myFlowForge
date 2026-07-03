import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessions, newSession, closeSession } from './sessionStore'
import type { ChatSession } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ws-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

const ro: ChatSession[] = [{ id: 'ext-claude-a1', title: 'H', mode: 'chat', createdAt: 1, readonly: true, external: { source: 'claude', externalId: 'a1', filePaths: [] } }]

describe('readSessions + imported merge', () => {
  it('轻量工作区(无可写)直接展示只读会话, 不建空会话', () => {
    const out = readSessions(ws, { derive: () => ro })
    expect(out.sessions.map(s => s.id)).toEqual(['ext-claude-a1'])
    expect(out.sessions.every(s => s.readonly)).toBe(true)
  })
  it('有可写会话时合并, 可写在前只读在后', () => {
    mkdirSync(join(ws, '.forge'), { recursive: true })
    writeFileSync(join(ws, '.forge', 'sessions.json'), JSON.stringify({ sessions: [{ id: 's-1', title: '我的', mode: 'chat', createdAt: 9 }], activeSessionId: 's-1' }))
    const out = readSessions(ws, { derive: () => ro })
    expect(out.sessions.map(s => s.id)).toEqual(['s-1', 'ext-claude-a1'])
    expect(out.activeSessionId).toBe('s-1')
  })
  it('无可写无只读时维持原行为(建空会话)', () => {
    const out = readSessions(ws, { derive: () => [] })
    expect(out.sessions.length).toBe(1)
    expect(out.sessions[0].title).toBe('新会话')
  })
})

describe('write guard: 只读会话不写入磁盘', () => {
  it('newSession 后磁盘文件不含 readonly/ext- 会话 (即使磁盘已被污染)', () => {
    // 模拟"磁盘已被污染"：sessions.json 里已有一个可写 + 一个只读会话
    mkdirSync(join(ws, '.forge'), { recursive: true })
    writeFileSync(join(ws, '.forge', 'sessions.json'), JSON.stringify({
      sessions: [
        { id: 's-writable', title: '可写', mode: 'chat', createdAt: 9 },
        { id: 'ext-claude-a1', title: 'H', mode: 'chat', createdAt: 1, readonly: true, external: { source: 'claude', externalId: 'a1', filePaths: [] } },
      ],
      activeSessionId: 's-writable',
    }))

    // newSession 内部调 readSessions→write，write 应过滤只读
    newSession(ws)

    const onDisk = JSON.parse(readFileSync(join(ws, '.forge', 'sessions.json'), 'utf8')) as { sessions: ChatSession[] }
    expect(onDisk.sessions.every(s => !s.readonly)).toBe(true)
    expect(onDisk.sessions.every(s => !s.id.startsWith('ext-'))).toBe(true)
    expect(onDisk.sessions.length).toBeGreaterThanOrEqual(1)
  })

  it('1 个可写 + N 个只读时 closeSession 守卫拒绝删唯一可写会话', () => {
    // 磁盘预置：1 个可写 + 2 个只读（模拟污染或内存态写入磁盘场景）
    mkdirSync(join(ws, '.forge'), { recursive: true })
    writeFileSync(join(ws, '.forge', 'sessions.json'), JSON.stringify({
      sessions: [
        { id: 's-only', title: '唯一可写', mode: 'chat', createdAt: 9 },
        { id: 'ext-claude-a1', title: 'RO1', mode: 'chat', createdAt: 1, readonly: true, external: { source: 'claude', externalId: 'a1', filePaths: [] } },
        { id: 'ext-codex-b2', title: 'RO2', mode: 'chat', createdAt: 2, readonly: true, external: { source: 'codex', externalId: 'b2', filePaths: [] } },
      ],
      activeSessionId: 's-only',
    }))

    // 守卫应拒绝：只有 1 个可写会话，不能删
    const result = closeSession(ws, 's-only')
    expect(result.sessions.some(s => s.id === 's-only')).toBe(true)
  })
})

describe('dismissImported: 只读导入会话可被叉掉(关闭)且不再重现', () => {
  it('closeSession 关闭只读会话 → 记入 dismissedImported 并从列表移除', () => {
    mkdirSync(join(ws, '.forge'), { recursive: true })
    writeFileSync(join(ws, '.forge', 'sessions.json'), JSON.stringify({
      sessions: [
        { id: 's-1', title: '可写', mode: 'chat', createdAt: 9 },
        { id: 'ext-claude-a1', title: 'RO1', mode: 'chat', createdAt: 1, readonly: true, external: { source: 'claude', externalId: 'a1', filePaths: [] } },
      ],
      activeSessionId: 'ext-claude-a1',
    }))
    const out = closeSession(ws, 'ext-claude-a1')
    expect(out.sessions.some(s => s.id === 'ext-claude-a1')).toBe(false)
    expect(out.dismissedImported).toContain('ext-claude-a1')
    // active 落回剩余会话
    expect(out.activeSessionId).toBe('s-1')
    // 持久化:磁盘上 dismissedImported 落盘
    const onDisk = JSON.parse(readFileSync(join(ws, '.forge', 'sessions.json'), 'utf8')) as { dismissedImported?: string[] }
    expect(onDisk.dismissedImported).toContain('ext-claude-a1')
  })

  it('被叉掉的只读会话即便 derive 再次返回也不重现', () => {
    mkdirSync(join(ws, '.forge'), { recursive: true })
    writeFileSync(join(ws, '.forge', 'sessions.json'), JSON.stringify({
      sessions: [{ id: 's-1', title: '可写', mode: 'chat', createdAt: 9 }],
      activeSessionId: 's-1',
      dismissedImported: ['ext-claude-a1'],
    }))
    // derive 仍想塞回这个被叉掉的只读会话
    const out = readSessions(ws, { derive: () => ro })
    expect(out.sessions.some(s => s.id === 'ext-claude-a1')).toBe(false)
    expect(out.sessions.map(s => s.id)).toEqual(['s-1'])
  })
})

describe('closeSession guard: 可写会话数决定守卫', () => {
  it('有 2 个可写会话时 closeSession 可正常删一个', () => {
    mkdirSync(join(ws, '.forge'), { recursive: true })
    writeFileSync(join(ws, '.forge', 'sessions.json'), JSON.stringify({
      sessions: [
        { id: 's-1', title: '会话1', mode: 'chat', createdAt: 1 },
        { id: 's-2', title: '会话2', mode: 'chat', createdAt: 2 },
      ],
      activeSessionId: 's-2',
    }))

    // derive 注入只读会话（总数=3，但可写=2，应允许删除）
    const result = closeSession(ws, 's-1')
    expect(result.sessions.some(s => s.id === 's-1')).toBe(false)
    expect(result.sessions.some(s => s.id === 's-2')).toBe(true)

    // 磁盘上也不含只读会话
    const onDisk = JSON.parse(readFileSync(join(ws, '.forge', 'sessions.json'), 'utf8')) as { sessions: ChatSession[] }
    expect(onDisk.sessions.every(s => !s.readonly)).toBe(true)
  })
})
