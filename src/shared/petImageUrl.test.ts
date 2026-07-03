import { describe, it, expect } from 'vitest'
import { petImageUrl } from './petImageUrl'

describe('petImageUrl', () => {
  it('maps a stored relative path to a forge-pet:// url', () => {
    expect(petImageUrl('pet1/idle.png')).toBe('forge-pet://img/pet1/idle.png')
  })
  it('encodes each path segment', () => {
    expect(petImageUrl('pet a/id le.png')).toBe('forge-pet://img/pet%20a/id%20le.png')
  })
  it('passes data URLs through unchanged (legacy / preview)', () => {
    expect(petImageUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
  })
  it('returns undefined for undefined input', () => {
    expect(petImageUrl(undefined)).toBeUndefined()
  })
})
