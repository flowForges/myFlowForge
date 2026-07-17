import { describe, it, expect } from 'vitest'
import { addFeedback, editFeedback, removeFeedback, drainFeedback, type FeedbackDraft } from './feedback'

describe('feedback drafts', () => {
  it('add/edit/remove are pure', () => {
    const l0: FeedbackDraft[] = []
    const l1 = addFeedback(l0, 'f1', '记得加幂等键')
    expect(l1).toEqual([{ id: 'f1', text: '记得加幂等键' }])
    expect(l0).toEqual([])
    const l2 = editFeedback(l1, 'f1', '改成全局锁')
    expect(l2[0].text).toBe('改成全局锁')
    expect(l1[0].text).toBe('记得加幂等键')
    const l3 = removeFeedback(l2, 'f1')
    expect(l3).toEqual([])
  })
  it('drainFeedback joins text and clears', () => {
    const l = addFeedback(addFeedback([], 'f1', 'A'), 'f2', 'B')
    const { text, drained } = drainFeedback(l)
    expect(text).toBe('A\nB')
    expect(drained).toEqual([])
  })
  it('drainFeedback on empty returns empty', () => {
    expect(drainFeedback([])).toEqual({ text: '', drained: [] })
  })
})
