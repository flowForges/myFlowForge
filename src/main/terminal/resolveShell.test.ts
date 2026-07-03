import { describe, it, expect } from 'vitest'
import { resolveShell } from './resolveShell'

describe('resolveShell', () => {
  const all = () => true
  it('prefers $SHELL when it exists', () => {
    expect(resolveShell({ SHELL: '/opt/homebrew/bin/fish' }, all)).toEqual({ shell: '/opt/homebrew/bin/fish', args: ['-l'] })
  })
  it('falls back zsh → bash → sh when $SHELL missing/nonexistent', () => {
    expect(resolveShell({}, p => p === '/bin/zsh').shell).toBe('/bin/zsh')
    expect(resolveShell({ SHELL: '/no/such' }, p => p === '/bin/bash').shell).toBe('/bin/bash')
    expect(resolveShell({}, () => false).shell).toBe('/bin/sh')
  })
})
