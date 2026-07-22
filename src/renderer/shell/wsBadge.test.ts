import { describe, it, expect } from 'vitest'
import { deriveWsBadge } from './wsBadge'

describe('deriveWsBadge', () => {
  it('input outranks confirm outranks run', () => {
    expect(deriveWsBadge({ live: true, confirm: 2, input: 1 })).toEqual({ kind: 'input', count: 1 })
    expect(deriveWsBadge({ live: true, confirm: 3, input: 0 })).toEqual({ kind: 'confirm', count: 3 })
    expect(deriveWsBadge({ live: true, confirm: 0, input: 0 })).toEqual({ kind: 'run', count: 1 })
  })
  it('nothing running → null', () => {
    expect(deriveWsBadge({ live: false, confirm: 0, input: 0 })).toBeNull()
  })
  it('confirm/input show even if not marked live', () => {
    expect(deriveWsBadge({ live: false, confirm: 1, input: 0 })).toEqual({ kind: 'confirm', count: 1 })
  })
})
