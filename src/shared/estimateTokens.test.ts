import { describe, it, expect } from 'vitest'
import { estimateTokens } from './estimateTokens'

describe('estimateTokens', () => {
  it('is 0 for empty / whitespace', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   ')).toBe(0)
  })
  it('counts latin text at roughly chars/4', () => {
    // 16 non-space chars → ~4 tokens.
    expect(estimateTokens('abcd efgh ijkl mnop')).toBe(4)
  })
  it('counts CJK denser (≈1 token per han character)', () => {
    // 5 Han chars → 5 tokens (latin at /4 would wrongly give ~1).
    expect(estimateTokens('上下文消耗')).toBe(5)
  })
  it('grows monotonically with content', () => {
    expect(estimateTokens('hello world this is a longer sentence with more words'))
      .toBeGreaterThan(estimateTokens('hello'))
  })
})
