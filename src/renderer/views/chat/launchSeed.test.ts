import { describe, it, expect } from 'vitest'
import { buildConversationSeed } from './launchSeed'

describe('buildConversationSeed', () => {
  it('拼接最近的用户消息为种子，忽略空文本', () => {
    const msgs = [
      { id: '1', who: 'me', text: '把 token 迁到 OKLCH', provider: 'claude' },
      { id: '2', who: 'ai', text: '好的，我建议…', provider: 'claude' },
      { id: '3', who: 'me', text: '  ', provider: 'claude' },
    ] as any
    const seed = buildConversationSeed(msgs)
    expect(seed).toContain('把 token 迁到 OKLCH')
    expect(seed).not.toMatch(/^\s+$/)
  })

  it('turns messages into a "我/AI" transcript', () => {
    const conversation = [
      { id: 'm1', who: 'user', text: '做个登录页', ts: '1' },
      { id: 'm2', who: 'ai', text: '好的,我先看看现有页面结构', ts: '2' },
    ] as any
    expect(buildConversationSeed(conversation)).toBe(
      '我: 做个登录页\n\nAI: 好的,我先看看现有页面结构',
    )
  })

  it('returns "" for an empty conversation', () => {
    expect(buildConversationSeed([])).toBe('')
  })
})
