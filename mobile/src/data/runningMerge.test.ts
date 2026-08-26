import { describe, expect, it } from 'vitest'
import { applyEvent, mergeSnapshot, type RunningByWs } from './runningMerge'

describe('mergeSnapshot', () => {
  it('fills an absent bucket', () => {
    const prev: RunningByWs = {}
    const next = mergeSnapshot(prev, '/a', ['s1'])
    expect(next).toEqual({ '/a': ['s1'] })
  })

  it('returns the exact same object identity when the bucket already has live data', () => {
    const prev: RunningByWs = { '/a': ['s1'] }
    const next = mergeSnapshot(prev, '/a', ['s2'])
    expect(next).toBe(prev)
  })

  it('treats an empty ids array as "has data" — presence of the key guards, not truthiness', () => {
    const prev: RunningByWs = { '/a': [] }
    const next = mergeSnapshot(prev, '/a', ['s1'])
    expect(next).toBe(prev)
    expect(next).toEqual({ '/a': [] })
  })

  it('fills a second, still-absent bucket without touching an existing one', () => {
    const prev: RunningByWs = { '/a': ['s1'] }
    const next = mergeSnapshot(prev, '/b', ['s2'])
    expect(next).toEqual({ '/a': ['s1'], '/b': ['s2'] })
    expect(next).not.toBe(prev)
  })
})

describe('applyEvent', () => {
  it('replaces a bucket wholesale, even one that already existed', () => {
    const prev: RunningByWs = { '/a': ['s1', 's2'] }
    const next = applyEvent(prev, '/a', ['s3'])
    expect(next).toEqual({ '/a': ['s3'] })
  })

  it('adds a new bucket without touching existing ones', () => {
    const prev: RunningByWs = { '/a': ['s1'] }
    const next = applyEvent(prev, '/b', [])
    expect(next).toEqual({ '/a': ['s1'], '/b': [] })
  })
})
