import { describe, it, expect } from 'vitest'
import { makeProposeGuard } from './proposeGuard'

describe('makeProposeGuard', () => {
  it('allows the first `max` calls (default 3)', () => {
    const blocked = makeProposeGuard()
    expect(blocked()).toBe(false)   // call 1
    expect(blocked()).toBe(false)   // call 2
    expect(blocked()).toBe(false)   // call 3
  })

  it('blocks the 4th call (and every subsequent call)', () => {
    const blocked = makeProposeGuard()
    blocked(); blocked(); blocked()        // 1-3: allowed
    expect(blocked()).toBe(true)           // 4th: blocked
    expect(blocked()).toBe(true)           // 5th: still blocked
  })

  it('a fresh guard always resets the counter (simulates a new turn)', () => {
    const guard1 = makeProposeGuard()
    guard1(); guard1(); guard1()           // exhaust guard1
    expect(guard1()).toBe(true)            // guard1 is blocked

    const guard2 = makeProposeGuard()     // new turn → fresh guard
    expect(guard2()).toBe(false)           // counter reset, first call allowed
  })

  it('respects a custom max', () => {
    const blocked = makeProposeGuard(1)
    expect(blocked()).toBe(false)   // call 1: allowed
    expect(blocked()).toBe(true)    // call 2: blocked
  })

  it('max=0 blocks every call immediately', () => {
    const blocked = makeProposeGuard(0)
    expect(blocked()).toBe(true)
  })
})
