import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessagesTokens, SESSION_DISTILL_THRESHOLD, DISTILL_OLDEST_N } from './tokenEstimate'
import type { ChatMessage } from '@shared/types'

const msg = (text: string): ChatMessage => ({ id: 'x', who: 'user', text, ts: '00:00:00' })

describe('tokenEstimate', () => {
  it('estimates ~length/3 chars per token, never negative', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('a'.repeat(300))).toBe(100)
  })
  it('treats undefined/empty text as 0', () => {
    expect(estimateTokens(undefined)).toBe(0)
  })
  it('sums message texts', () => {
    const total = estimateMessagesTokens([msg('a'.repeat(300)), msg('b'.repeat(60))])
    expect(total).toBe(100 + 20)
  })
  it('exposes sane threshold + oldest-N constants', () => {
    expect(SESSION_DISTILL_THRESHOLD).toBeGreaterThan(1000)
    expect(DISTILL_OLDEST_N).toBeGreaterThan(0)
  })
})
