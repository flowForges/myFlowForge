import { describe, it, expect, vi } from 'vitest'
import { buildContinuationPreamble, buildLocalHistoryPreamble } from './continuation'
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

describe('buildLocalHistoryPreamble (provider switch continuity)', () => {
  it('re-feeds Forge-stored messages so a switched provider keeps context', () => {
    const p = buildLocalHistoryPreamble('/ws', 's-2', { read: () => hist })
    expect(p).toContain('用户：原问题')
    expect(p).toContain('助手：原回答')
  })
  it('empty when the session has no prior messages (fresh session first turn)', () => {
    expect(buildLocalHistoryPreamble('/ws', 's-new', { read: () => [] })).toBe('')
  })

  it('fromIndex slices to only messages from that index onward (incremental catch-up)', () => {
    const long: ImportedMessage[] = [
      { who: 'user', text: '第一个问题', ts: '' },
      { who: 'ai', text: '第一个回答', ts: '' },
      { who: 'user', text: '第二个问题', ts: '' },
      { who: 'ai', text: '第二个回答', ts: '' },
    ]
    const p = buildLocalHistoryPreamble('/ws', 's-2', { read: () => long }, { fromIndex: 2 })
    expect(p).not.toContain('第一个问题')
    expect(p).not.toContain('第一个回答')
    expect(p).toContain('第二个问题')
    expect(p).toContain('第二个回答')
  })

  it('fromIndex omitted behaves like the full-history default', () => {
    const p = buildLocalHistoryPreamble('/ws', 's-2', { read: () => hist })
    expect(p).toContain('用户：原问题')
  })
})

describe('★★「这条是谁发的」绝不进上下文', () => {
  /**
   * 用户的原话:「这个内容只是展示,复制的时候不应该被复制进去,也不应该 Agent 加载进去,
   * 避免造成上下文污染」。
   *
   * ★这条不是靠谁记得去删。`via` 是 `ChatMessage` 上的**独立字段**,而喂给模型的这条路上
   *  `buildLocalHistoryPreamble` 的默认 `read` 明确地只挑 `{ who, text, ts }` 三样出来 ——
   *  设备名在**进入这条管道之前**就被丢掉了,后面每一层都不可能再看到它。
   * ★这里连着真的 `readMessages` 跑(只 mock 磁盘那一层),所以钉的是**整条真实路径**,
   *  不是我在测试里手搓的一个 `{who,text,ts}`。
   */
  it('带 via 的消息喂进历史前缀,设备名一个字都找不到', async () => {
    vi.resetModules()
    vi.doMock('./chatStore', () => ({
      readMessages: () => [
        { id: 'u1', who: 'user', text: '把这个 bug 修了', ts: 't', via: 'iPhone' },
        { id: 'a1', who: 'ai', text: '好的', ts: 't' },
        { id: 'u2', who: 'user', text: '再跑一遍测试', ts: 't', via: '书房的 Mac' },
      ],
      readSessions: () => ({ sessions: [] }),
    }))
    const { buildLocalHistoryPreamble: build } = await import('./continuation')
    const p = build('/ws', 's-1')
    expect(p).toContain('把这个 bug 修了')
    expect(p).toContain('再跑一遍测试')
    expect(p).not.toContain('iPhone')
    expect(p).not.toContain('书房的 Mac')
    expect(p).not.toContain('via')
    vi.doUnmock('./chatStore')
    vi.resetModules()
  })
})
