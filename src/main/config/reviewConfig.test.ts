import { describe, it, expect } from 'vitest'
import { WsStageSchema, ReviewConfigSchema, REVIEW_LENSES } from './schema'

describe('ReviewConfig schema', () => {
  it('REVIEW_LENSES is the fixed lens set', () => {
    expect(REVIEW_LENSES).toEqual(['correctness', 'security', 'performance', 'style'])
  })

  it('parses a single-mode config', () => {
    const c = ReviewConfigSchema.parse({ mode: 'single' })
    expect(c.mode).toBe('single')
    expect(c.scope).toBeUndefined()
  })

  it('parses parallel per-project with numeric reviewers', () => {
    const c = ReviewConfigSchema.parse({ mode: 'parallel', scope: 'per-project', reviewers: 3 })
    expect(c).toMatchObject({ mode: 'parallel', scope: 'per-project', reviewers: 3 })
  })

  it('parses parallel multi-lens (reviewers = lens list)', () => {
    const c = ReviewConfigSchema.parse({ mode: 'parallel', scope: 'workspace', reviewers: ['correctness', 'security'] })
    expect(c.reviewers).toEqual(['correctness', 'security'])
  })

  it('rejects an unknown mode and an unknown lens', () => {
    expect(() => ReviewConfigSchema.parse({ mode: 'nope' })).toThrow()
    expect(() => ReviewConfigSchema.parse({ mode: 'parallel', reviewers: ['typos'] })).toThrow()
  })

  it('WsStage parses with review absent (back-compat) and with review present', () => {
    const legacy = WsStageSchema.parse({ key: 'review', provider: 'claude', model: 'opus-4.8' })
    expect(legacy.review).toBeUndefined()
    const withReview = WsStageSchema.parse({ key: 'review', provider: 'claude', model: 'opus-4.8', review: { mode: 'single' } })
    expect(withReview.review?.mode).toBe('single')
  })
})
