import { describe, it, expect } from 'vitest'
import { fmtDuration } from './duration'

describe('fmtDuration', () => {
  it.each([
    [0, '00:00'], [999, '00:00'], [1500, '00:01'], [38_000, '00:38'], [102_000, '01:42'], [247_000, '04:07'],
    [3_599_999, '59:59'], [3_600_000, '1:00:00'], [3_725_000, '1:02:05'], [36_000_000, '10:00:00'],
  ])('%i ms → %s', (ms, want) => { expect(fmtDuration(ms)).toBe(want) })
})
