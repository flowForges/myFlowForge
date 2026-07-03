import { describe, it, expect } from 'vitest'
import { parseOsc7, parseLsofCwd, abbreviateHome } from './cwdTrack'

describe('cwdTrack', () => {
  it('parseOsc7 extracts the decoded path (BEL- and ST-terminated)', () => {
    expect(parseOsc7('\x1b]7;file://host/Users/me/a%20b\x07')).toBe('/Users/me/a b')
    expect(parseOsc7('x\x1b]7;file:///Users/me/p\x1b\\y')).toBe('/Users/me/p')
    expect(parseOsc7('no osc here')).toBeNull()
  })
  it('parseLsofCwd reads the n-line from `lsof -Fn` output', () => {
    expect(parseLsofCwd('p1234\nfcwd\nn/Users/me/proj\n')).toBe('/Users/me/proj')
    expect(parseLsofCwd('p1234\n')).toBeNull()
  })
  it('abbreviateHome collapses the home prefix to ~', () => {
    expect(abbreviateHome('/Users/me/proj', '/Users/me')).toBe('~/proj')
    expect(abbreviateHome('/Users/me', '/Users/me')).toBe('~')
    expect(abbreviateHome('/tmp/x', '/Users/me')).toBe('/tmp/x')
  })
})
