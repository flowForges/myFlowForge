import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandTilde } from './paths'

describe('expandTilde', () => {
  it('expands a bare ~ to the home dir', () => {
    expect(expandTilde('~')).toBe(homedir())
  })
  it('expands ~/path to an absolute home path (not a literal ~ dir)', () => {
    expect(expandTilde('~/work/workspace/example')).toBe(join(homedir(), 'work/workspace/example'))
  })
  it('leaves an already-absolute path untouched', () => {
    expect(expandTilde('/Users/x/y')).toBe('/Users/x/y')
  })
  it('does not touch a ~ that is not a leading home reference', () => {
    expect(expandTilde('/a/~b/c')).toBe('/a/~b/c')
  })
})
