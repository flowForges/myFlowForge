import { describe, expect, it } from 'vitest'
import { isOom, nextDelayMs, shouldTrip } from './backoff'

const MIN = 60_000

describe('backoff', () => {
  it('delay doubles from 1 s and caps at 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(nextDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
  })

  it('10 failures within 4 min trips crash-loop', () => {
    const now = 10 * MIN
    const history = Array.from({ length: 10 }, (_, i) => ({ at: now - 4 * MIN + i * 24_000, oom: false }))
    expect(shouldTrip(history, now)).toEqual({ trip: true, reason: 'crash-loop' })
  })

  it('10 failures spread over 6 min does not trip', () => {
    const now = 10 * MIN
    const history = Array.from({ length: 10 }, (_, i) => ({ at: now - 6 * MIN + i * 40_000, oom: false }))
    expect(shouldTrip(history, now)).toEqual({ trip: false })
  })

  it('9 failures within 5 min does not trip', () => {
    const now = 10 * MIN
    const history = Array.from({ length: 9 }, (_, i) => ({ at: now - i * 1000, oom: false }))
    expect(shouldTrip(history, now)).toEqual({ trip: false })
  })

  it('2 OOM within 20 min trips oom', () => {
    const now = 60 * MIN
    expect(shouldTrip([{ at: now - 20 * MIN, oom: true }, { at: now, oom: true }], now)).toEqual({ trip: true, reason: 'oom' })
  })

  it('2 OOM 40 min apart does not trip', () => {
    const now = 60 * MIN
    expect(shouldTrip([{ at: now - 40 * MIN, oom: true }, { at: now, oom: true }], now)).toEqual({ trip: false })
  })

  it('isOom: exit code 134 or heap message', () => {
    expect(isOom({ code: 134, signal: null, stderrTail: '' })).toBe(true)
    expect(isOom({ code: 1, signal: null, stderrTail: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' })).toBe(true)
    expect(isOom({ code: 1, signal: null, stderrTail: 'boom' })).toBe(false)
    expect(isOom({ code: null, signal: 'SIGKILL', stderrTail: '' })).toBe(false)
  })
})
