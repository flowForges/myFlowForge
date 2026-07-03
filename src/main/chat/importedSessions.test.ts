import { describe, it, expect } from 'vitest'
import { deriveImportedSessions } from './importedSessions'
import type { ImportedIndex } from '@shared/types'

const idx: ImportedIndex = { version: 1, scannedAt: 0, sessions: [
  { source: 'claude', externalId: 'a1', cwd: '/repo', title: '会话A', startedAt: 100, lastTs: 200, messageCount: 4, filePaths: ['/x/a1.jsonl'], hasBody: true },
  { source: 'codex',  externalId: 'b2', cwd: '/repo', title: '会话B', startedAt: 300, lastTs: 400, messageCount: 2, filePaths: ['/x/b2.jsonl'], hasBody: true },
  { source: 'claude', externalId: 'c3', cwd: '/other', title: '别处', startedAt: 1, lastTs: 1, messageCount: 1, filePaths: ['/x/c3.jsonl'], hasBody: true },
] }

describe('deriveImportedSessions', () => {
  it('只取该 cwd, 倒序, 映射只读字段', () => {
    const out = deriveImportedSessions('/repo', { readIndex: () => idx })
    expect(out.map(s => s.id)).toEqual(['ext-codex-b2', 'ext-claude-a1']) // lastTs 倒序
    expect(out[1]).toMatchObject({
      id: 'ext-claude-a1', title: '会话A', readonly: true, mode: 'chat', createdAt: 100,
      external: { source: 'claude', externalId: 'a1', filePaths: ['/x/a1.jsonl'] },
    })
    expect('messages' in out[1]).toBe(false)
  })
  it('无匹配返回空', () => {
    expect(deriveImportedSessions('/none', { readIndex: () => idx })).toEqual([])
  })
})
