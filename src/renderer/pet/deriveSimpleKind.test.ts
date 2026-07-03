import { describe, it, expect } from 'vitest'
import { deriveSimpleKind } from './deriveSimpleKind'

describe('deriveSimpleKind', () => {
  it('maps working → running', () => {
    expect(deriveSimpleKind('working')).toBe('running')
  })
  it('passes confirm / input / done / idle through unchanged', () => {
    expect(deriveSimpleKind('confirm')).toBe('confirm')
    expect(deriveSimpleKind('input')).toBe('input')
    expect(deriveSimpleKind('done')).toBe('done')
    expect(deriveSimpleKind('idle')).toBe('idle')
  })
})
