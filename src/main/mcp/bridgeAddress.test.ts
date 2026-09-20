import { describe, it, expect } from 'vitest'
import { bridgeAddress } from './bridgeAddress'

describe('bridgeAddress (POSIX)', () => {
  it('puts the socket in the run directory, next to the run artifacts', () => {
    expect(bridgeAddress('/ws/.forge/runs/r1', 'r1', 'darwin')).toEqual({
      socketPath: '/ws/.forge/runs/r1/forge.sock',
      configDir: '/ws/.forge/runs/r1',
      isPipe: false,
    })
  })

  // sun_path is 104 bytes on darwin; a socket path over the limit is silently truncated by bind(),
  // and the MCP child then connects to a path that doesn't exist.
  it('falls back to the temp dir when the run path would blow the sun_path limit', () => {
    const deep = '/Users/someone/' + 'nested-workspace-directory/'.repeat(5) + '.forge/runs/run-1'
    const a = bridgeAddress(deep, 'run-1', 'darwin')
    expect(a.socketPath.length).toBeLessThanOrEqual(100)
    expect(a.socketPath).not.toContain(deep)
    expect(a.socketPath).toContain('run-1')
    // The MCP config file follows the socket, so both stay in one writable place.
    expect(a.configDir).toBe(a.socketPath.slice(0, a.socketPath.lastIndexOf('/')))
  })
})

describe('bridgeAddress (Windows)', () => {
  it('uses a named pipe — Windows has no filesystem sockets', () => {
    const a = bridgeAddress('C:\\ws\\.forge\\runs\\r1', 'r1', 'win32')
    expect(a.socketPath).toBe('\\\\.\\pipe\\forge-r1')
    expect(a.isPipe).toBe(true)
  })

  // dirname('\\.\pipe\forge-r1') is '\\.\pipe', which is not a writable directory — the per-agent
  // MCP config file has to keep going to the run directory instead.
  it('keeps the MCP config file in the run directory, not beside the pipe', () => {
    expect(bridgeAddress('C:\\ws\\.forge\\runs\\r1', 'r1', 'win32').configDir).toBe('C:\\ws\\.forge\\runs\\r1')
  })

  it('sanitises the run id — pipe names cannot contain a backslash', () => {
    const a = bridgeAddress('C:\\ws', 'run/1:2 3\\4', 'win32')
    expect(a.socketPath.startsWith('\\\\.\\pipe\\')).toBe(true)
    expect(a.socketPath.slice('\\\\.\\pipe\\'.length)).not.toMatch(/[\\/:*?"<>|]/)
  })

  it('gives two runs two different pipes', () => {
    const a = bridgeAddress('C:\\ws', 'r1', 'win32').socketPath
    const b = bridgeAddress('C:\\ws', 'r2', 'win32').socketPath
    expect(a).not.toBe(b)
  })

  it('never applies the POSIX length fallback (a pipe name has no sun_path limit)', () => {
    const deep = 'C:\\' + 'nested-workspace-directory\\'.repeat(6) + '.forge\\runs\\run-1'
    expect(bridgeAddress(deep, 'run-1', 'win32').configDir).toBe(deep)
  })
})
