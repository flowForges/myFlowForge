import { describe, it, expect } from 'vitest'
import { normalizeWindow } from './normalize'

const NOW = 1_700_000_000_000 // ms

describe('normalizeWindow', () => {
  it('reads explicit used + limit', () => {
    expect(normalizeWindow({ used: 30, limit: 100 }, NOW)).toEqual({ used: 30, limit: 100 })
  })
  it('reads percent-only as used with limit 100', () => {
    expect(normalizeWindow({ used_percent: 42.6 }, NOW)).toEqual({ used: 43, limit: 100 })
  })
  it('reads remainingFraction (0..1) as used with limit 100', () => {
    expect(normalizeWindow({ remainingFraction: 0.25 }, NOW)).toEqual({ used: 75, limit: 100 })
  })
  it('reads resetAt from epoch seconds → ms', () => {
    const w = normalizeWindow({ used: 1, limit: 2, resets_at: 1_700_000_500 }, NOW)
    expect(w?.resetAt).toBe(1_700_000_500_000)
  })
  it('reads resetAt from epoch ms unchanged', () => {
    const w = normalizeWindow({ used: 1, limit: 2, resetAt: 1_700_000_500_000 }, NOW)
    expect(w?.resetAt).toBe(1_700_000_500_000)
  })
  it('reads resetAt from ISO string', () => {
    const w = normalizeWindow({ used: 1, limit: 2, resetTime: '2023-11-14T22:14:00.000Z' }, NOW)
    expect(typeof w?.resetAt).toBe('number')
  })
  it('reads resetAt from relative seconds', () => {
    const w = normalizeWindow({ used: 1, limit: 2, resets_in_seconds: 300 }, NOW)
    expect(w?.resetAt).toBe(NOW + 300_000)
  })
  it('returns undefined when no usage info', () => {
    expect(normalizeWindow({}, NOW)).toBeUndefined()
    expect(normalizeWindow(null, NOW)).toBeUndefined()
  })
})
