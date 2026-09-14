import { describe, it, expect } from 'vitest'
import { adaptCodexEvent, codexTokenUsage } from './codexEventAdapter'
import { parseCodexEvent, codexToolActivity } from './codex'

describe('adaptCodexEvent', () => {
  it('adapts an agentMessage delta to a streamable assistant delta', () => {
    const e = adaptCodexEvent({ method: 'item/agentMessage/delta', params: { delta: 'hel' } })
    expect(parseCodexEvent(e)).toEqual([{ kind: 'assistant', text: 'hel' }])
  })
  it('adapts a completed agentMessage to assistant-final', () => {
    const e = adaptCodexEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: 'done' } } })
    expect(parseCodexEvent(e)).toEqual([{ kind: 'assistant-final', text: 'done' }])
  })
  it('adapts a completed commandExecution so codexToolActivity renders it', () => {
    const e = adaptCodexEvent({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', command: 'ls -la', output: 'x', exit_code: 0 } } })
    const act = codexToolActivity(e)
    expect(act?.id).toBe('c1'); expect(act?.phase).toBe('done'); expect(act?.title).toContain('ls -la')
  })
  it('adapts an item.started commandExecution to a live row', () => {
    const e = adaptCodexEvent({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'ls' } } })
    expect(codexToolActivity(e)?.phase).toBe('start')
  })
  it('adapts a fileChange to an edit step', () => {
    const e = adaptCodexEvent({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }] } } })
    expect(codexToolActivity(e)?.title).toContain('a.ts')
  })
  it('returns null for chatty notifications', () => {
    expect(adaptCodexEvent({ method: 'thread/tokenUsage/updated', params: {} })).toBeNull()
    expect(adaptCodexEvent({ method: 'mcpServer/startupStatus/updated', params: {} })).toBeNull()
  })
})

/**
 * codex 是唯一一个把**已用和窗口两个数都官方上报**的 provider(`thread/tokenUsage/updated`)。
 * 别的 provider 窗口靠 CLI 报、报不到就没有;codex 这条连窗口都直接给,能画出真正可信的占比。
 * ★这条通知原来被 adaptCodexEvent 返回 null 丢掉了,所以 codex 一直一个字都看不到。
 */
describe('codexTokenUsage', () => {
  const note = (tokenUsage: unknown) => ({ method: 'thread/tokenUsage/updated', params: { threadId: 't', turnId: 'u', tokenUsage } })

  it('★取 last 不取 total —— total 是整个 thread 的累计,拿它当占用量会让进度条虚高到 100%', () => {
    // 和 claude 那边刻意跳过 result 事件是同一个道理(见 extractContextTokens 的注释)。
    expect(codexTokenUsage(note({
      last: { inputTokens: 1000, cachedInputTokens: 200, cacheWriteInputTokens: 50, outputTokens: 999, reasoningOutputTokens: 500, totalTokens: 2749 },
      total: { inputTokens: 900000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 900000 },
      modelContextWindow: 272000,
    }))).toEqual({ used: 1250, window: 272000 })
  })

  it('★只算输入侧:output 和 reasoning 不是上下文占用(它们下一轮才变成输入)', () => {
    expect(codexTokenUsage(note({
      last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5000, reasoningOutputTokens: 5000, totalTokens: 10010 },
      total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10 },
      modelContextWindow: 1000,
    }))?.used).toBe(10)
  })

  it('窗口可以缺席(schema 里 modelContextWindow 是可空的)→ 只给 used', () => {
    expect(codexTokenUsage(note({
      last: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 7 },
      total: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 7 },
      modelContextWindow: null,
    }))).toEqual({ used: 7, window: undefined })
  })

  it('不是这条通知、或者形状不对 → null', () => {
    expect(codexTokenUsage({ method: 'item/completed', params: {} })).toBeNull()
    expect(codexTokenUsage(note(null))).toBeNull()
    expect(codexTokenUsage(note({ total: { inputTokens: 5 } }))).toBeNull()   // 没有 last
    expect(codexTokenUsage(null)).toBeNull()
  })
})
