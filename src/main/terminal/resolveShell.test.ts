import { describe, it, expect } from 'vitest'
import { resolveShell } from './resolveShell'

describe('resolveShell (POSIX)', () => {
  const all = () => true
  it('prefers $SHELL when it exists', () => {
    expect(resolveShell({ SHELL: '/opt/homebrew/bin/fish' }, all, 'darwin')).toEqual({ shell: '/opt/homebrew/bin/fish', args: ['-l'] })
  })
  it('falls back zsh → bash → sh when $SHELL missing/nonexistent', () => {
    expect(resolveShell({}, p => p === '/bin/zsh', 'darwin').shell).toBe('/bin/zsh')
    expect(resolveShell({ SHELL: '/no/such' }, p => p === '/bin/bash', 'darwin').shell).toBe('/bin/bash')
    expect(resolveShell({}, () => false, 'darwin').shell).toBe('/bin/sh')
  })
})

describe('resolveShell (Windows)', () => {
  const WIN_ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }
  const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  const WPS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

  it('prefers PowerShell 7 (pwsh.exe) when installed', () => {
    expect(resolveShell(WIN_ENV, () => true, 'win32').shell).toBe(PWSH7)
  })
  it('falls back to Windows PowerShell when pwsh.exe is absent', () => {
    expect(resolveShell(WIN_ENV, p => p === WPS, 'win32').shell).toBe(WPS)
  })
  it('falls back to %COMSPEC% when no PowerShell is installed', () => {
    expect(resolveShell(WIN_ENV, p => p === WIN_ENV.COMSPEC, 'win32').shell).toBe('C:\\Windows\\system32\\cmd.exe')
  })
  it('last-resorts to bare cmd.exe (PATH lookup) when nothing on disk matches', () => {
    expect(resolveShell(WIN_ENV, () => false, 'win32').shell).toBe('cmd.exe')
  })
  it('never passes the POSIX -l login flag on Windows', () => {
    expect(resolveShell(WIN_ENV, () => true, 'win32').args).not.toContain('-l')
  })
  it('passes -NoLogo to PowerShell so the terminal opens on a clean line', () => {
    expect(resolveShell(WIN_ENV, () => true, 'win32').args).toEqual(['-NoLogo'])
  })
  it('passes no args to cmd.exe (-NoLogo is a PowerShell-only flag)', () => {
    expect(resolveShell(WIN_ENV, p => p === WIN_ENV.COMSPEC, 'win32').args).toEqual([])
  })
  it('ignores $SHELL on Windows (Git Bash sets it to an MSYS path that is not a native shell)', () => {
    const env = { ...WIN_ENV, SHELL: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' }
    expect(resolveShell(env, () => true, 'win32').shell).toBe(PWSH7)
  })
  it('tolerates a stripped environment with no SystemRoot/ProgramFiles', () => {
    expect(resolveShell({}, () => false, 'win32')).toEqual({ shell: 'cmd.exe', args: [] })
  })
})
