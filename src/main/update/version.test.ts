import { describe, it, expect } from 'vitest'
import { compareVersions, isNewer } from './version'

describe('compareVersions', () => {
  it('orders by major.minor.patch', () => {
    expect(compareVersions('2.4.0', '2.3.1')).toBe(1)
    expect(compareVersions('2.3.1', '2.4.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })
  it('tolerates a leading v', () => {
    expect(compareVersions('v2.4.0', '2.3.9')).toBe(1)
  })
  it('treats a prerelease as lower than the same release', () => {
    expect(compareVersions('2.4.0-beta.1', '2.4.0')).toBe(-1)
    expect(compareVersions('2.4.0', '2.4.0-beta.1')).toBe(1)
  })
  it('pads missing segments', () => {
    expect(compareVersions('2.4', '2.4.0')).toBe(0)
    expect(compareVersions('2.4.1', '2.4')).toBe(1)
  })
})

describe('isNewer', () => {
  it('is true only when latest > current', () => {
    expect(isNewer('2.4.0', '1.0.0')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.9.0', '1.0.0')).toBe(false)
  })
})
