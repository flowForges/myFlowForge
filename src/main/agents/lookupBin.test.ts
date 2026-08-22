import { describe, it, expect, vi } from 'vitest'
import { lookupCommand, pickBinPath, lookupBin } from './lookupBin'

describe('lookupCommand', () => {
  it('uses which on POSIX and where on Windows', () => {
    expect(lookupCommand('darwin')).toBe('which')
    expect(lookupCommand('linux')).toBe('which')
    expect(lookupCommand('win32')).toBe('where')
  })
})

describe('pickBinPath (POSIX)', () => {
  it('takes the single path which prints', () => {
    expect(pickBinPath('/opt/homebrew/bin/claude\n', 'darwin')).toBe('/opt/homebrew/bin/claude')
  })
  it('empty output → nothing found', () => {
    expect(pickBinPath('', 'darwin')).toBeNull()
    expect(pickBinPath('   \n', 'darwin')).toBeNull()
  })
})

describe('pickBinPath (Windows)', () => {
  // `where` prints EVERY match, one per line. An npm global install of a CLI lays down three files
  // side by side: an extensionless shell script (for Git Bash), a .cmd and a .ps1. Only the .cmd is
  // executable by Windows, so taking the first line can hand back a file that cannot be run.
  const NPM_SHIMS = [
    'C:\\Users\\me\\AppData\\Roaming\\npm\\claude',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.ps1',
  ].join('\r\n') + '\r\n'

  it('prefers the .cmd shim over the extensionless shell script', () => {
    expect(pickBinPath(NPM_SHIMS, 'win32')).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
  })
  it('prefers a real .exe over any shim', () => {
    const out = 'C:\\tools\\x\\gh.cmd\r\nC:\\Program Files\\GitHub CLI\\gh.exe\r\n'
    expect(pickBinPath(out, 'win32')).toBe('C:\\Program Files\\GitHub CLI\\gh.exe')
  })
  // 真机取证(2026-08-22,Win11 虚拟机,`npm i -g @openai/codex` 之后跑 `where codex`):
  //   C:\Users\zghua\AppData\Roaming\npm\codex
  //   C:\Users\zghua\AppData\Roaming\npm\codex.cmd
  // 第一行就是那个【Windows 执行不了】的无扩展名 shell 脚本 —— 取第一行的朴素实现会把它存成 binPath。
  it('★ 真机取证:npm 装的 codex,where 的第一行是执行不了的那个', () => {
    const REAL = 'C:\\Users\\zghua\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\zghua\\AppData\\Roaming\\npm\\codex.cmd\r\n'
    expect(pickBinPath(REAL, 'win32')).toBe('C:\\Users\\zghua\\AppData\\Roaming\\npm\\codex.cmd')
    // 明确钉住"不是第一行"
    expect(pickBinPath(REAL, 'win32')).not.toBe(REAL.split(/\r?\n/)[0])
  })

  it('accepts a .bat shim when that is all there is', () => {
    expect(pickBinPath('C:\\tools\\thing.bat\r\n', 'win32')).toBe('C:\\tools\\thing.bat')
  })
  it('falls back to the first line when nothing has a runnable extension', () => {
    expect(pickBinPath('C:\\tools\\weird\r\n', 'win32')).toBe('C:\\tools\\weird')
  })
  it('handles CRLF and where.exe error text', () => {
    expect(pickBinPath('INFO: Could not find files for the given pattern(s).\r\n', 'win32')).toBeNull()
    expect(pickBinPath('', 'win32')).toBeNull()
  })
  it('keeps spaces inside a path', () => {
    expect(pickBinPath('C:\\Program Files\\My App\\x.exe\r\n', 'win32')).toBe('C:\\Program Files\\My App\\x.exe')
  })
})

describe('lookupBin', () => {
  it('POSIX: runs `which <bin>`', async () => {
    const run = vi.fn(async () => ({ stdout: '/usr/local/bin/codex', exitCode: 0 }))
    expect(await lookupBin('codex', {}, 'darwin', run)).toBe('/usr/local/bin/codex')
    expect(run).toHaveBeenCalledWith('which', ['codex'], expect.anything())
  })
  it('Windows: runs `where <bin>`', async () => {
    const run = vi.fn(async () => ({ stdout: 'C:\\npm\\codex.cmd\r\n', exitCode: 0 }))
    expect(await lookupBin('codex', {}, 'win32', run)).toBe('C:\\npm\\codex.cmd')
    expect(run).toHaveBeenCalledWith('where', ['codex'], expect.anything())
  })
  it('not found (non-zero exit) → null, never a throw', async () => {
    const run = async () => { throw new Error('Command failed with exit code 1') }
    expect(await lookupBin('nope', {}, 'win32', run)).toBeNull()
  })
  it('a zero exit with empty output is still "not found"', async () => {
    const run = async () => ({ stdout: '\r\n', exitCode: 0 })
    expect(await lookupBin('nope', {}, 'win32', run)).toBeNull()
  })
})
