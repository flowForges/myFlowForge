import { describe, it, expect } from 'vitest'
import { isRecoverable } from './reconcile'

const cfg = { stallMs: 90_000, killGraceMs: 60_000 }

describe('isRecoverable', () => {
  it('socket present + recent beat within stall+grace -> recoverable', () => {
    expect(isRecoverable({ socketAlive: true, lastBeat: 9_950_000, now: 10_000_000, cfg })).toBe(true)
  })

  it('socket present but beat older than stall+grace -> not recoverable', () => {
    expect(isRecoverable({ socketAlive: true, lastBeat: 9_000_000, now: 10_000_000, cfg })).toBe(false)
  })

  it('no socket -> not recoverable regardless of beat', () => {
    expect(isRecoverable({ socketAlive: false, lastBeat: 9_999_999, now: 10_000_000, cfg })).toBe(false)
  })

  it('no beat recorded -> not recoverable', () => {
    expect(isRecoverable({ socketAlive: true, lastBeat: undefined, now: 10_000_000, cfg })).toBe(false)
  })
})
