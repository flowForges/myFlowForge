import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// ★ Review Focus 21 (spec V3). execa is mocked: nothing here starts a process, and the launcher is a
//   plain temp file standing in for the helper — it is never executed.
const calls: { bin: string; args: string[]; opts: Record<string, unknown> }[] = []
let nextPid = 40_000

function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>
  ee.pid = ++nextPid
  ee.kill = vi.fn(() => true)
  ee.stdin = { write: vi.fn() }
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  return ee
}

vi.mock('execa', () => ({
  execa: vi.fn((bin: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ bin, args: [...args], opts })
    return fakeChild()
  }),
}))

const { configureDisclaim, disclaimedSpawnArgs, DISCLAIM_REFUSED, spawnAgent, liveAgentChildren, trackAgentChild } = await import('./procGroup')
const { driveCodexTurn } = await import('./providers/codexAppServer')
const { fetchCodexUsageViaRpc } = await import('../usage/codexRpc')

let dir: string
let binDir: string
let launcher: string
let claudeAbs: string
let codexAbs: string

function exe(p: string) { writeFileSync(p, '#!/bin/sh\nexit 0\n'); chmodSync(p, 0o755) }

beforeEach(() => {
  calls.length = 0
  dir = mkdtempSync(join(tmpdir(), 'disclaim-'))
  binDir = join(dir, 'bin')
  mkdirSync(binDir)
  launcher = join(dir, 'launcher')
  exe(launcher)
  claudeAbs = join(binDir, 'claude'); exe(claudeAbs)
  codexAbs = join(binDir, 'codex'); exe(codexAbs)
})

afterEach(() => {
  // back to the default: not provisioned
  configureDisclaim({ launcher: () => null, enabled: () => false })
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const on = (over: Partial<Parameters<typeof configureDisclaim>[0]> = {}) =>
  configureDisclaim({ launcher: () => launcher, enabled: () => true, platform: 'darwin', ...over })

describe('disclaimedSpawnArgs', () => {
  it('darwin + provisioned + launcher + bin on PATH → launcher exec -- <abs> …args', () => {
    on()
    expect(disclaimedSpawnArgs('claude', ['-p', 'hi'], { PATH: binDir })).toEqual({
      bin: launcher, args: ['exec', '--', claudeAbs, '-p', 'hi'], disclaimed: true,
    })
  })

  it('not provisioned → original', () => {
    on({ enabled: () => false })
    expect(disclaimedSpawnArgs('claude', ['-p'], { PATH: binDir })).toEqual({ bin: 'claude', args: ['-p'], disclaimed: false })
  })

  it.each(['win32', 'linux'] as const)('%s → original', (platform) => {
    on({ platform })
    expect(disclaimedSpawnArgs('claude', ['-p'], { PATH: binDir })).toEqual({ bin: 'claude', args: ['-p'], disclaimed: false })
  })

  it('M-1: provisioned but the launcher is missing (null, not on disk, relative or throwing) → refused, never the plain bin', () => {
    const refused = { bin: '/bin/sh', args: ['-c', 'printf \'%s\\n\' "$1" >&2; exit 125', 'forge-cu', DISCLAIM_REFUSED], disclaimed: false, refused: true }
    for (const launcherFn of [() => null, () => join(dir, 'nope'), () => 'launcher', () => { throw new Error('x') }]) {
      on({ launcher: launcherFn })
      expect(disclaimedSpawnArgs('claude', ['-p'], { PATH: binDir })).toEqual(refused)
    }
  })

  it('M-1: not provisioned with no launcher stays the original call', () => {
    on({ launcher: () => null, enabled: () => false })
    expect(disclaimedSpawnArgs('claude', [], { PATH: binDir })).toEqual({ bin: 'claude', args: [], disclaimed: false })
  })

  it('bin not resolvable on env.PATH → original (ENOENT behaviour unchanged)', () => {
    on()
    expect(disclaimedSpawnArgs('nosuchcli', ['x'], { PATH: binDir })).toEqual({ bin: 'nosuchcli', args: ['x'], disclaimed: false })
    expect(disclaimedSpawnArgs('claude', [], {})).toEqual({ bin: 'claude', args: [], disclaimed: false })
  })

  it('a non-executable file on PATH is skipped, the next PATH entry wins', () => {
    on()
    const first = join(dir, 'first'); mkdirSync(first)
    writeFileSync(join(first, 'claude'), 'not exec')
    expect(disclaimedSpawnArgs('claude', [], { PATH: `${first}:${binDir}` }).args.slice(0, 3)).toEqual(['exec', '--', claudeAbs])
  })

  it('an absolute bin is used as is; a missing absolute bin falls back', () => {
    on()
    expect(disclaimedSpawnArgs(claudeAbs, ['a'], {}).args).toEqual(['exec', '--', claudeAbs, 'a'])
    expect(disclaimedSpawnArgs(join(dir, 'gone'), [], {}).disclaimed).toBe(false)
  })

  it('a relative path with a slash resolves against cwd', () => {
    on()
    expect(disclaimedSpawnArgs('./bin/claude', [], {}, dir).args).toEqual(['exec', '--', claudeAbs])
  })

  it('a relative PATH segment resolves against cwd, like execvp in the child', () => {
    on()
    expect(disclaimedSpawnArgs('claude', [], { PATH: 'bin' }, dir).args).toEqual(['exec', '--', claudeAbs])
  })

  it('a throwing enabled() falls back to the original spawn', () => {
    on({ enabled: () => { throw new Error('x') } })
    expect(disclaimedSpawnArgs('claude', [], { PATH: binDir }).disclaimed).toBe(false)
  })

  it('default (never configured) is off', async () => {
    vi.resetModules()
    const fresh = await import('./procGroup')
    expect(fresh.disclaimedSpawnArgs(claudeAbs, [], { PATH: binDir }).disclaimed).toBe(false)
  })
})

// C-1: the reader side. Once enabled() has said true in this run, the seam stays on even if the settings read
// later says false (client.json rewritten) or throws (corrupted), until configureDisclaim runs again (app start).
describe('enabled() is latched', () => {
  it('true once → stays true when the source flips to false or throws', () => {
    let src: () => boolean = () => false
    on({ enabled: () => src() })
    expect(disclaimedSpawnArgs('claude', [], { PATH: binDir }).disclaimed).toBe(false)
    src = () => true
    expect(disclaimedSpawnArgs('claude', [], { PATH: binDir }).disclaimed).toBe(true)
    src = () => false
    expect(disclaimedSpawnArgs('claude', [], { PATH: binDir }).disclaimed).toBe(true)
    src = () => { throw new Error('corrupt') }
    expect(disclaimedSpawnArgs('claude', [], { PATH: binDir }).disclaimed).toBe(true)
  })

  it('a non-boolean truthy value does not latch', () => {
    on({ enabled: () => 'yes' as unknown as boolean })
    expect(disclaimedSpawnArgs('claude', [], { PATH: binDir }).disclaimed).toBe(false)
  })

  it('a throwing source before any true stays off (today\'s behaviour)', () => {
    on({ enabled: () => { throw new Error('x') } })
    expect(disclaimedSpawnArgs('claude', [], { PATH: binDir }).disclaimed).toBe(false)
  })
})

describe('spawnAgent goes through the seam', () => {
  it('provisioned: execa(launcher, [exec, --, abs claude, …args]) with the same options + process group', () => {
    on()
    const env = { PATH: binDir, X: '1' }
    const child = spawnAgent('claude', ['-p', 'q'], { env, cwd: dir, reject: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe(launcher)
    expect(calls[0].args).toEqual(['exec', '--', claudeAbs, '-p', 'q'])
    expect(calls[0].opts).toMatchObject({ env, cwd: dir, reject: false, detached: true })
    expect(liveAgentChildren()).toContainEqual({ pid: child.pid, disclaimed: true })
    ;(child as unknown as EventEmitter).emit('close')
  })

  it('not provisioned: the call is exactly the original one', () => {
    const env = { PATH: binDir }
    const child = spawnAgent('claude', ['-p'], { env, reject: false })
    expect(calls[0].bin).toBe('claude')
    expect(calls[0].args).toEqual(['-p'])
    expect(liveAgentChildren()).toContainEqual({ pid: child.pid, disclaimed: false })
    ;(child as unknown as EventEmitter).emit('close')
  })

  it('M-1: provisioned and the launcher gone: execa runs the refusal (exit 125 with the reason on stderr), not the agent', () => {
    on({ launcher: () => null })
    const child = spawnAgent('claude', ['-p', 'q'], { env: { PATH: binDir }, reject: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe('/bin/sh')
    expect(calls[0].args).not.toContain(claudeAbs)
    expect(calls[0].args.at(-1)).toBe(DISCLAIM_REFUSED)
    ;(child as unknown as EventEmitter).emit('close')
  })

  it('unresolvable bin: original call even when provisioned', () => {
    on()
    const child = spawnAgent('nosuchcli', ['a'], { env: { PATH: binDir }, reject: false })
    expect(calls[0]).toMatchObject({ bin: 'nosuchcli', args: ['a'] })
    ;(child as unknown as EventEmitter).emit('close')
  })

  it('PATH falls back to process.env when opts.env has none (execa extends the env)', () => {
    on()
    vi.stubEnv('PATH', binDir)
    const child = spawnAgent('claude', [], { reject: false })
    expect(calls[0].args).toEqual(['exec', '--', claudeAbs])
    ;(child as unknown as EventEmitter).emit('close')
  })

  it('extendEnv:false without env.PATH → original (we would not find it either)', () => {
    on()
    vi.stubEnv('PATH', binDir)
    const child = spawnAgent('claude', [], { env: {}, extendEnv: false, reject: false })
    expect(calls[0].bin).toBe('claude')
    ;(child as unknown as EventEmitter).emit('close')
  })

  it('liveAgentChildren drops a child once it closes; a manually tracked child defaults to disclaimed:false', () => {
    const child = spawnAgent('claude', [], { env: { PATH: binDir }, reject: false })
    expect(liveAgentChildren().some(c => c.pid === child.pid)).toBe(true)
    ;(child as unknown as EventEmitter).emit('close')
    expect(liveAgentChildren().some(c => c.pid === child.pid)).toBe(false)
    const raw = fakeChild()
    trackAgentChild(raw as never, { ownGroup: false })
    expect(liveAgentChildren()).toContainEqual({ pid: raw.pid, disclaimed: false })
    raw.emit('close')
  })
})

describe('the two codex app-server spawns use the same seam', () => {
  it('driveCodexTurn (no injected spawn) → launcher exec -- <abs codex> … app-server', () => {
    on()
    vi.stubEnv('PATH', binDir)
    const h = driveCodexTurn(
      { cwd: dir, prompt: 'p', modelArgs: ['-m', 'x'], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      { onEvent: () => {}, onApproval: async () => 'deny', onSession: () => {}, onError: () => {} },
    )
    expect(calls[0].bin).toBe(launcher)
    expect(calls[0].args).toEqual(['exec', '--', codexAbs, '-m', 'x', 'app-server'])
    expect(liveAgentChildren().some(c => c.disclaimed)).toBe(true)
    h.cancel()
  })

  it('fetchCodexUsageViaRpc (no injected spawn) → launcher exec -- <abs codex> -s read-only -a untrusted app-server', async () => {
    on()
    vi.stubEnv('PATH', binDir)
    const p = fetchCodexUsageViaRpc({ timeoutMs: 1 }).catch(() => null)
    expect(calls[0].bin).toBe(launcher)
    expect(calls[0].args).toEqual(['exec', '--', codexAbs, '-s', 'read-only', '-a', 'untrusted', 'app-server'])
    await p
  })

  it('not provisioned: both stay `codex` + original args', async () => {
    vi.stubEnv('PATH', binDir)
    const h = driveCodexTurn(
      { cwd: dir, prompt: 'p', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      { onEvent: () => {}, onApproval: async () => 'deny', onSession: () => {}, onError: () => {} },
    )
    await fetchCodexUsageViaRpc({ timeoutMs: 1 }).catch(() => null)
    expect(calls.map(c => [c.bin, c.args.at(-1)])).toEqual([['codex', 'app-server'], ['codex', 'app-server']])
    h.cancel()
  })
})
