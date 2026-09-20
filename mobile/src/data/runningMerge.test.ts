import { describe, expect, it } from 'vitest'
import { applyEvent, mergeSnapshot, runningKey, type RunningByWs } from './runningMerge'

describe('runningKey', () => {
  it('keeps the same session id in two workspaces apart', () => {
    // 会话 id 会撞:`s-${Date.now()}-${++seq}`,seq 每次起进程从 0 数(sessionStore.ts)。
    expect(runningKey('/a', 's-1-1')).not.toBe(runningKey('/b', 's-1-1'))
  })

  it('cannot be forged by a workspace path that ends with the separator-ish text', () => {
    // NUL 不可能出现在 POSIX 路径里,所以 (ws, id) → key 是单射;换成空格/冒号就不是了。
    expect(runningKey('/a b', 'c')).not.toBe(runningKey('/a', 'b c'))
    expect(runningKey('/a', 'b')).toBe('/a\0b')
  })
})

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
