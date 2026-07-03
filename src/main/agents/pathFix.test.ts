import { describe, it, expect } from 'vitest'
import { mergePath, fixExecPath } from './pathFix'

describe('mergePath', () => {
  it('prepends shell PATH, keeps current, appends fallbacks, de-duped order-preserving', () => {
    const out = mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin', '/Users/x')
    const parts = out.split(':')
    expect(parts[0]).toBe('/opt/homebrew/bin')        // shell PATH first
    expect(parts).toContain('/usr/bin')
    expect(parts).toContain('/bin')
    expect(parts).toContain('/Users/x/.local/bin')    // fallback dir
    // no duplicates
    expect(new Set(parts).size).toBe(parts.length)
  })
  it('handles empty shell PATH (falls back to current + dirs)', () => {
    const out = mergePath('/usr/bin', '', '/Users/x')
    expect(out.split(':')[0]).toBe('/usr/bin')
    expect(out).toContain('/opt/homebrew/bin')
  })
})

describe('fixExecPath', () => {
  it('no-op when not packaged', () => {
    expect(fixExecPath({ packaged: false, platform: 'darwin', env: { PATH: '/usr/bin' }, readShell: () => '/x' })).toBeUndefined()
  })
  it('no-op on win32', () => {
    expect(fixExecPath({ packaged: true, platform: 'win32', env: { PATH: 'C:\\' }, readShell: () => '' })).toBeUndefined()
  })
  it('packaged darwin merges injected shell PATH', () => {
    const out = fixExecPath({ packaged: true, platform: 'darwin', env: { PATH: '/usr/bin', SHELL: '/bin/zsh' }, readShell: () => '/opt/homebrew/bin' })
    expect(out).toBeDefined()
    expect(out!.split(':')[0]).toBe('/opt/homebrew/bin')
    expect(out).toContain('/usr/bin')
  })
})
