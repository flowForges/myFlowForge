import { describe, it, expect } from 'vitest'
import { buildContinuationPreamble } from './continuation'
import type { ChatSession, ImportedMessage } from '@shared/types'

const sessions: ChatSession[] = [
  { id: 's-1', title: '续 · X', mode: 'chat', createdAt: 1, continuedFrom: { source: 'claude', externalId: 'a1' }, external: { source: 'claude', externalId: 'a1', filePaths: ['/x.jsonl'] } },
  { id: 's-2', title: '普通', mode: 'chat', createdAt: 2 },
]
const hist: ImportedMessage[] = [{ who: 'user', text: '原问题', ts: '' }, { who: 'ai', text: '原回答', ts: '' }]

describe('buildContinuationPreamble', () => {
  it('续聊会话注入历史前缀', () => {
    const p = buildContinuationPreamble('/ws', 's-1', { sessions, read: () => hist })
    expect(p).toContain('用户：原问题')
    expect(p).toContain('助手：原回答')
  })
  it('普通会话返回空', () => {
    expect(buildContinuationPreamble('/ws', 's-2', { sessions, read: () => hist })).toBe('')
  })
})
