import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRoots, resolveToolPath } from '../lib/fs/paths'
import { decide, PermissionGate, type PermissionRequest } from './permissionGate'
import { Sessions, type SessionInfo } from './sessions'
import type { KernelEvent } from '../protocol/index'

describe('decide (table)', () => {
  const home = '/h'
  const dataDir = '/h/.myFlowForge/mff-ai'
  const spillDir = `${dataDir}/sessions/s1/spill`
  const env = { roots: credentialRoots(home, 'linux', {}), dataDir, spillDir, platform: 'linux' as const }
  const ask: SessionInfo = { sessionId: 's1', cwd: '/h/repo', approvalMode: 'ask' }
  const auto: SessionInfo = { ...ask, approvalMode: 'auto' }
  const atHome: SessionInfo = { ...ask, cwd: home }
  const noCwd: SessionInfo = { sessionId: 's1', approvalMode: 'auto' }
  const req = (action: string, resource?: string, actor = 'plugin:tools'): PermissionRequest => ({ actor, action, resource, sessionId: 's1' })

  const cases: [string, PermissionRequest, SessionInfo | undefined, 'allow' | 'deny' | 'ask'][] = [
    ['kernel actor', req('anything', '/etc/passwd', 'kernel'), undefined, 'allow'],
    ['read inside', req('read', '/h/repo/a.txt'), ask, 'allow'],
    ['write inside', req('write', '/h/repo/sub/new.txt'), ask, 'allow'],
    ['read cwd itself', req('read', '/h/repo'), ask, 'allow'],
    ['read outside', req('read', '/etc/passwd'), ask, 'deny'],
    ['write outside', req('write', '/tmp/x'), auto, 'deny'],
    ['sibling prefix', req('read', '/h/repo2/x'), ask, 'deny'],
    ['read via .. (already resolved)', req('read', resolveToolPath('/h/repo', '../other/x', { platform: 'linux', exists: () => false })), ask, 'deny'],
    ['relative resource', req('read', 'a.txt'), ask, 'deny'],
    ['missing resource', req('read'), ask, 'deny'],
    ['inside cwd but under ~/.ssh', req('read', '/h/.ssh/id_ed25519'), atHome, 'deny'],
    ['inside cwd but ~/.netrc', req('write', '/h/.netrc'), atHome, 'deny'],
    ['inside cwd, ordinary file', req('read', '/h/notes.txt'), atHome, 'allow'],
    ['mff-ai dataDir read', req('read', `${dataDir}/credentials.enc`), atHome, 'deny'],
    ['mff-ai dataDir write', req('write', `${dataDir}/token`), atHome, 'deny'],
    ['other session spill', req('read', `${dataDir}/sessions/s2/spill/x.txt`), atHome, 'deny'],
    ['spill read', req('read', `${spillDir}/c1-read.txt`), ask, 'allow'],
    ['spill read, no cwd', req('read', `${spillDir}/c1-read.txt`), noCwd, 'allow'],
    ['spill write', req('write', `${spillDir}/c1-read.txt`), atHome, 'deny'],
    ['exec under ask', req('exec', 'npm test'), ask, 'ask'],
    ['exec under auto', req('exec', 'npm test'), auto, 'allow'],
    ['exec without a session', req('exec', 'npm test'), undefined, 'deny'],
    ['unknown action', req('delete', '/h/repo/a.txt'), auto, 'deny'],
    ['session without cwd: read', req('read', '/h/repo/a.txt'), noCwd, 'deny'],
    ['session without cwd: exec auto', req('exec', 'ls'), noCwd, 'allow'],
    ['unknown session: read', req('read', '/h/repo/a.txt'), undefined, 'deny'],
    ['NUL sentinel', req('read', resolveToolPath('/h/repo', 'a\0b', { platform: 'linux' })), ask, 'deny'],
  ]
  it.each(cases)('%s', (_name, r, s, want) => {
    expect(decide(r, s, env)).toBe(want)
  })

  it('darwin: case variants of a blacklisted root are denied', () => {
    const d = { ...env, roots: credentialRoots(home, 'darwin', {}), platform: 'darwin' as const }
    expect(decide(req('read', '/h/.SSH/id'), atHome, d)).toBe('deny')
    expect(decide(req('read', '/H/REPO/a'), ask, d)).toBe('allow')
    const dataVol: SessionInfo = { ...ask, cwd: '/System/Volumes/Data' }
    expect(decide(req('write', '/private/etc/x'), dataVol, d)).toBe('deny')
    expect(decide(req('write', '/System/Volumes/Data/private/etc/x'), dataVol, d)).toBe('deny')
    expect(decide(req('read', '/h/repo/a'), { ...ask, cwd: '/System/Volumes/Data/h/repo' }, d)).toBe('deny') // h 不是 firmlink 目录
  })

  it('win32: other drive, UNC and ADS are denied', () => {
    const w = { roots: credentialRoots('C:\\Users\\u', 'win32', {}), dataDir: 'C:\\Users\\u\\.mff', platform: 'win32' as const }
    const s: SessionInfo = { sessionId: 's1', cwd: 'C:\\repo', approvalMode: 'auto' }
    expect(decide(req('read', 'c:\\REPO\\x'), s, w)).toBe('allow')
    for (const p of ['D:\\x', '\\\\server\\share\\x', '\\\\?\\C:\\repo\\x', 'C:\\repo\\a.txt:stream'])
      expect(decide(req('write', p), s, w)).toBe('deny')
  })
})

describe('PermissionGate.check (real tree)', () => {
  let home: string
  let dataDir: string
  let outside: string
  beforeEach(() => {
    // 不先 realpath:macOS 上 tmpdir 是 /var/...,真实路径是 /private/var/...
    home = mkdtempSync(join(tmpdir(), 'mffai-gate-home-'))
    outside = mkdtempSync(join(tmpdir(), 'mffai-gate-out-'))
    dataDir = join(home, '.myFlowForge', 'mff-ai')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(join(home, 'repo'))
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'k')
    writeFileSync(join(outside, 'secret'), 's')
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  const gateFor = (cwd: string, approvalMode: 'ask' | 'auto' = 'ask') => {
    const sessions = new Sessions(dataDir)
    const ev: KernelEvent = { seq: 1, ts: 0, type: 'session.created', sessionId: 's1', payload: { cwd: realpathSync.native(cwd), approvalMode } }
    sessions.observe(ev)
    return { gate: new PermissionGate({ sessions, home, dataDir, platform: process.platform, env: {} }), cwd: realpathSync.native(cwd) }
  }
  const check = (gate: PermissionGate, action: string, resource: string) => gate.check({ actor: 'plugin:tools', action, resource, sessionId: 's1' })

  it('Review Focus 2: a symlink escape is denied and nothing is created', () => {
    const { gate, cwd } = gateFor(join(home, 'repo'))
    symlinkSync(outside, join(cwd, 'link'), 'dir')
    expect(check(gate, 'write', resolveToolPath(cwd, 'link/new/x.txt'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, 'link/secret'))).toBe('deny')
    expect(existsSync(join(outside, 'new'))).toBe(false)
    expect(existsSync(join(outside, 'new', 'x.txt'))).toBe(false)
    expect(check(gate, 'write', resolveToolPath(cwd, 'ok/new.txt'))).toBe('allow')
  })

  it('cwd = home: ~/.ssh and the dataDir are denied, other files allowed', () => {
    const { gate, cwd } = gateFor(home)
    expect(check(gate, 'read', resolveToolPath(cwd, '.ssh/id_ed25519'))).toBe('deny')
    expect(check(gate, 'write', resolveToolPath(cwd, '.ssh/new_key'))).toBe('deny')
    expect(check(gate, 'write', resolveToolPath(cwd, '.aws/credentials'))).toBe('deny') // 不存在的根也拦
    expect(check(gate, 'read', resolveToolPath(cwd, '.myFlowForge/mff-ai/credentials.enc'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, 'repo/a.txt'))).toBe('allow')
  })

  it('I1: case-fold spellings of absent credential roots are denied on this platform', () => {
    const { gate, cwd } = gateFor(home)
    const fold = process.platform === 'darwin' || process.platform === 'win32'
    for (const rel of ['.awſ/config', '.ſſh/authorized_keys', '.git-credentialſ', 'Library/Keychainſ/x'])
      expect(check(gate, 'write', resolveToolPath(cwd, rel)), rel).toBe(fold ? 'deny' : 'allow')
  })

  it('M1: a dangling ~/.ssh link into cwd blacklists its target', () => {
    rmSync(join(home, '.ssh'), { recursive: true })
    symlinkSync(join(home, 'repo', 'keys'), join(home, '.ssh'))
    const { gate, cwd } = gateFor(join(home, 'repo'))
    expect(check(gate, 'write', resolveToolPath(cwd, 'keys/authorized_keys'))).toBe('deny')
    expect(check(gate, 'write', resolveToolPath(cwd, 'src/a.ts'))).toBe('allow')
  })

  it('a symlinked credential dir is denied through its target', () => {
    const keys = join(outside, 'keys')
    mkdirSync(keys)
    rmSync(join(home, '.ssh'), { recursive: true })
    symlinkSync(keys, join(home, '.ssh'), 'dir')
    const { gate, cwd } = gateFor(home)
    expect(check(gate, 'read', resolveToolPath(cwd, '.ssh/id'))).toBe('deny')
  })

  it('reads in this session spillDir are allowed, writes are not', () => {
    const { gate } = gateFor(join(home, 'repo'))
    const spill = resolveToolPath(dataDir, 'sessions/s1/spill/c1-read.txt')
    expect(check(gate, 'read', spill)).toBe('allow')
    expect(check(gate, 'write', spill)).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(dataDir, 'sessions/s2/spill/c1-read.txt'))).toBe('deny')
  })

  it('exec follows approvalMode; unknown sessions are denied', () => {
    expect(check(gateFor(join(home, 'repo')).gate, 'exec', 'ls')).toBe('ask')
    expect(check(gateFor(join(home, 'repo'), 'auto').gate, 'exec', 'ls')).toBe('allow')
    const { gate } = gateFor(join(home, 'repo'), 'auto')
    expect(gate.check({ actor: 'plugin:tools', action: 'exec', resource: 'ls', sessionId: 'nope' })).toBe('deny')
    expect(gate.check({ actor: 'kernel', action: 'x' })).toBe('allow')
  })
})
