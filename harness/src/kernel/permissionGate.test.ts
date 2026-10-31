import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRoots, persistenceRoots, resolveToolPath } from '../lib/fs/paths'
import { decide, PermissionGate, type PermissionRequest } from './permissionGate'
import { Sessions, type SessionInfo } from './sessions'
import type { KernelEvent } from '../protocol/index'
import { createKernel, type Kernel } from './kernel'
import type { Plugin } from './pluginHost'

describe('decide (table)', () => {
  const home = '/h'
  const dataDir = '/h/.myFlowForge/mff-ai'
  const spillDir = `${dataDir}/sessions/s1/spill`
  const env = { roots: credentialRoots(home, 'linux', {}), persistence: persistenceRoots(home, 'linux'), dataDir, spillDir, platform: 'linux' as const }
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
    ['write .git/hooks', req('write', '/h/repo/.git/hooks/pre-commit'), auto, 'deny'],
    ['write .git/config', req('write', '/h/repo/.git/config'), auto, 'deny'],
    ['write .git file itself', req('write', '/h/repo/.git'), auto, 'deny'],
    ['write nested .git', req('write', '/h/repo/vendor/x/.git/config'), auto, 'deny'],
    ['read .git/config', req('read', '/h/repo/.git/config'), ask, 'allow'],
    ['write .github is fine', req('write', '/h/repo/.github/workflows/ci.yml'), ask, 'allow'],
    ['write .gitignore is fine', req('write', '/h/repo/.gitignore'), ask, 'allow'],
    ['write x.git is fine', req('write', '/h/repo/x.git/a'), ask, 'allow'],
    ['write ~/.zshrc, cwd = home', req('write', '/h/.zshrc'), atHome, 'deny'],
    ['read ~/.zshrc, cwd = home', req('read', '/h/.zshrc'), atHome, 'allow'],
    ['write ~/.config/fish/config.fish', req('write', '/h/.config/fish/config.fish'), atHome, 'deny'],
    ['write ~/.gitconfig', req('write', '/h/.gitconfig'), atHome, 'deny'],
    ['write ~/.config/git/config', req('write', '/h/.config/git/config'), atHome, 'deny'],
    ['write ~/Library/LaunchAgents plist', req('write', '/h/Library/LaunchAgents/x.plist'), atHome, 'deny'],
    ['write ~/.config/systemd/user unit', req('write', '/h/.config/systemd/user/x.service'), atHome, 'deny'],
    ['write ~/.config/autostart entry', req('write', '/h/.config/autostart/x.desktop'), atHome, 'deny'],
    ['write ~/.config/zsh/.zshrc', req('write', '/h/.config/zsh/.zshrc'), atHome, 'deny'],
    ['write ~/.zsh/.zshenv', req('write', '/h/.zsh/.zshenv'), atHome, 'deny'],
    ['read ~/.config/zsh/.zshrc', req('read', '/h/.config/zsh/.zshrc'), atHome, 'allow'],
    ['write ~/.config/zsh/plugin.zsh is fine', req('write', '/h/.config/zsh/plugin.zsh'), atHome, 'allow'],
    ['write ~/.zshrc.bak is fine', req('write', '/h/.zshrc.bak'), atHome, 'allow'],
    ['write ~/.config/other is fine', req('write', '/h/.config/other/x'), atHome, 'allow'],
    ['NUL sentinel', req('read', resolveToolPath('/h/repo', 'a\0b', { platform: 'linux' })), ask, 'deny'],
  ]
  it.each(cases)('%s', (_name, r, s, want) => {
    expect(decide(r, s, env)).toBe(want)
  })

  it('darwin: case variants of a blacklisted root are denied', () => {
    const d = { ...env, roots: credentialRoots(home, 'darwin', {}), persistence: persistenceRoots(home, 'darwin'), platform: 'darwin' as const }
    expect(decide(req('read', '/h/.SSH/id'), atHome, d)).toBe('deny')
    expect(decide(req('read', '/H/REPO/a'), ask, d)).toBe('allow')
    const dataVol: SessionInfo = { ...ask, cwd: '/System/Volumes/Data' }
    expect(decide(req('write', '/private/etc/x'), dataVol, d)).toBe('deny')
    expect(decide(req('write', '/System/Volumes/Data/private/etc/x'), dataVol, d)).toBe('deny')
    expect(decide(req('read', '/h/repo/a'), { ...ask, cwd: '/System/Volumes/Data/h/repo' }, d)).toBe('deny') // h 不是 firmlink 目录
  })

  it('darwin / win32: case and spelling variants of .git are denied for writes', () => {
    const d = { ...env, roots: credentialRoots(home, 'darwin', {}), persistence: persistenceRoots(home, 'darwin'), platform: 'darwin' as const }
    for (const p of ['/h/repo/.GIT/hooks/x', '/h/repo/.Git/config']) expect(decide(req('write', p), ask, d)).toBe('deny')
    const w = { roots: credentialRoots('C:\\Users\\u', 'win32', {}), persistence: persistenceRoots('C:\\Users\\u', 'win32'), dataDir: 'C:\\Users\\u\\.mff', platform: 'win32' as const }
    const s: SessionInfo = { sessionId: 's1', cwd: 'C:\\repo', approvalMode: 'auto' }
    for (const p of ['C:\\repo\\.GIT\\config', 'C:\\repo\\.git.\\hooks\\x', 'C:\\repo\\.git \\config', 'C:\\repo\\GIT~1\\config'])
      expect(decide(req('write', p), s, w)).toBe('deny')
    expect(decide(req('write', 'C:\\repo\\.github\\x'), s, w)).toBe('allow')
  })

  it('darwin: case variants of a persistence file are denied for writes', () => {
    const d = { ...env, roots: credentialRoots(home, 'darwin', {}), persistence: persistenceRoots(home, 'darwin'), platform: 'darwin' as const }
    for (const p of ['/h/.ZSHRC', '/h/.Bashrc', '/h/library/launchagents/x.plist']) expect(decide(req('write', p), atHome, d), p).toBe('deny')
    expect(decide(req('read', '/h/.ZSHRC'), atHome, d)).toBe('allow')
  })

  it('win32: other drive, UNC and ADS are denied', () => {
    const w = { roots: credentialRoots('C:\\Users\\u', 'win32', {}), persistence: persistenceRoots('C:\\Users\\u', 'win32'), dataDir: 'C:\\Users\\u\\.mff', platform: 'win32' as const }
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

  const gateFor = (cwd: string, approvalMode: 'ask' | 'auto' = 'ask', env: NodeJS.ProcessEnv = {}) => {
    const sessions = new Sessions(dataDir)
    const ev: KernelEvent = { seq: 1, ts: 0, type: 'session.created', sessionId: 's1', payload: { cwd: realpathSync.native(cwd), approvalMode } }
    sessions.observe(ev)
    return { gate: new PermissionGate({ sessions, home, dataDir, platform: process.platform, env }), cwd: realpathSync.native(cwd) }
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

  it('GNUPGHOME / AWS_SHARED_CREDENTIALS_FILE relocated into cwd are denied', () => {
    mkdirSync(join(outside, 'gpg'))
    writeFileSync(join(outside, 'gpg', 'x'), 'k')
    writeFileSync(join(outside, 'creds'), 'k')
    const env = { GNUPGHOME: join(outside, 'gpg'), AWS_SHARED_CREDENTIALS_FILE: join(outside, 'creds') }
    const { gate, cwd } = gateFor(outside, 'auto', env)
    expect(check(gate, 'read', resolveToolPath(cwd, 'gpg/x'))).toBe('deny')
    expect(check(gate, 'write', resolveToolPath(cwd, 'gpg/new'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, 'creds'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, 'secret'))).toBe('allow')
    // 同一目录、不带这些变量:放行
    expect(check(gateFor(outside, 'auto').gate, 'read', resolveToolPath(cwd, 'gpg/x'))).toBe('allow')
  })

  it('GNUPGHOME with a literal ~ is expanded against home and denied', () => {
    mkdirSync(join(home, 'keys', 'gpg'), { recursive: true })
    writeFileSync(join(home, 'keys', 'gpg', 'k'), 'k')
    const { gate, cwd } = gateFor(join(home, 'keys'), 'auto', { GNUPGHOME: '~/keys/gpg' })
    expect(check(gate, 'read', resolveToolPath(cwd, 'gpg/k'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, 'other'))).toBe('allow')
  })

  it('a not-yet-existing relocated root is denied too', () => {
    const { gate, cwd } = gateFor(outside, 'auto', { DOCKER_CONFIG: join(outside, 'docker') })
    expect(check(gate, 'write', resolveToolPath(cwd, 'docker/config.json'))).toBe('deny')
  })

  it('cwd = home: writing ~/.zshrc is denied, reading it is allowed', () => {
    writeFileSync(join(home, '.zshrc'), 'x')
    const { gate, cwd } = gateFor(home, 'auto')
    expect(check(gate, 'write', resolveToolPath(cwd, '.zshrc'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, '.zshrc'))).toBe('allow')
    expect(check(gate, 'write', resolveToolPath(cwd, '.bash_profile'))).toBe('deny') // 不存在的也拦
    expect(check(gate, 'write', resolveToolPath(cwd, 'Library/LaunchAgents/evil.plist'))).toBe('deny')
    expect(check(gate, 'write', resolveToolPath(cwd, 'repo/a.txt'))).toBe('allow')
  })

  it('a ~/.zshrc symlinked into a dotfiles repo: writing the target from that repo is denied', () => {
    mkdirSync(join(home, 'dotfiles'))
    writeFileSync(join(home, 'dotfiles', 'zshrc'), 'x')
    symlinkSync(join(home, 'dotfiles', 'zshrc'), join(home, '.zshrc'))
    const { gate, cwd } = gateFor(join(home, 'dotfiles'), 'auto')
    expect(check(gate, 'write', resolveToolPath(cwd, 'zshrc'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, 'zshrc'))).toBe('allow')
    expect(check(gate, 'write', resolveToolPath(cwd, 'README'))).toBe('allow')
  })

  it('ZDOTDIR moves the zsh rc files: writes there are denied', () => {
    const { gate, cwd } = gateFor(outside, 'auto', { ZDOTDIR: outside })
    expect(check(gate, 'write', resolveToolPath(cwd, '.zshrc'))).toBe('deny')
    expect(check(gate, 'write', resolveToolPath(cwd, 'secret'))).toBe('allow')
  })

  it('checkMany gives the same decisions as check, one per request', () => {
    const { gate, cwd } = gateFor(home)
    const reqs = [
      { actor: 'plugin:tools', action: 'read', resource: resolveToolPath(cwd, '.ssh/id_ed25519'), sessionId: 's1' },
      { actor: 'plugin:tools', action: 'read', resource: resolveToolPath(cwd, 'repo/a.txt'), sessionId: 's1' },
      { actor: 'plugin:tools', action: 'write', resource: resolveToolPath(cwd, 'repo/.git/config'), sessionId: 's1' },
      { actor: 'plugin:tools', action: 'read', resource: resolveToolPath(cwd, 'repo/a.txt'), sessionId: 'nope' },
      { actor: 'plugin:tools', action: 'read', resource: resolveToolPath(dataDir, 'sessions/s1/spill/x.txt'), sessionId: 's1' },
      { actor: 'kernel', action: 'x' },
    ]
    expect(gate.checkMany(reqs)).toEqual(['deny', 'allow', 'deny', 'deny', 'allow', 'allow'])
    expect(gate.checkMany(reqs)).toEqual(reqs.map(r => gate.check(r)))
    expect(gate.checkMany([])).toEqual([])
  })
})

describe('kernel env snapshot', () => {
  let home: string
  let dataDir: string
  let work: string
  let k: Kernel | undefined
  let gate: PermissionGate | undefined
  const probe: Plugin = {
    manifest: { id: 'probe', version: '0', kernel: '^0.1.0' },
    activate: ctx => { gate = ctx.services.get<PermissionGate>('permissionGate') },
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mffai-snap-home-'))
    dataDir = mkdtempSync(join(tmpdir(), 'mffai-snap-data-'))
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mffai-snap-work-')))
    mkdirSync(join(work, 'gpg'))
    mkdirSync(join(work, 'aws'))
    gate = undefined
  })
  afterEach(async () => {
    await k?.close().catch(() => {})
    k = undefined
    for (const d of [home, dataDir, work]) rmSync(d, { recursive: true, force: true })
  })

  it('decisions and validateCwd use the env given at createKernel; later mutation changes nothing', async () => {
    const env: NodeJS.ProcessEnv = { GNUPGHOME: join(work, 'gpg') }
    k = await createKernel({ dataDir, plugins: [probe], home, env, secrets: { osBackend: false } })
    env.GNUPGHOME = join(work, 'elsewhere')
    env.AWS_CONFIG_FILE = join(work, 'aws', 'config')
    const code = await (k.handle('session.create', { commandId: 'c0', cwd: join(work, 'gpg') }) as Promise<unknown>).then(() => undefined, (e: { code?: number }) => e.code)
    expect(code).toBe(-32602)
    const { sessionId } = await k.handle('session.create', { commandId: 'c1', cwd: work, approvalMode: 'auto' }) as { sessionId: string }
    const check = (action: string, rel: string) => gate!.check({ actor: 'plugin:tools', action, resource: resolveToolPath(work, rel), sessionId })
    expect(check('read', 'gpg/x')).toBe('deny')
    expect(check('read', 'aws/config')).toBe('allow')
    expect(check('read', 'elsewhere/x')).toBe('allow')
    // 后来才设的变量也不起作用:session.create 仍按快照判断
    const { sessionId: s2 } = await k.handle('session.create', { commandId: 'c2', cwd: join(work, 'aws') }) as { sessionId: string }
    expect(s2).toBeTruthy()
  })

  it('logs one line naming an over-broad variable, without its value', async () => {
    const lines: [string, unknown][] = []
    const log = { info() {}, error() {}, warn: (m: string, d?: unknown) => { lines.push([m, d]) } }
    k = await createKernel({ dataDir, plugins: [probe], home, env: { CODEX_HOME: home, DOCKER_CONFIG: '/', GNUPGHOME: join(work, 'gpg') }, log, secrets: { osBackend: false } })
    const hits = lines.filter(([m]) => m.includes('covers home or root'))
    expect(hits).toHaveLength(1)
    expect(hits[0][1]).toEqual({ vars: 'DOCKER_CONFIG:root,CODEX_HOME:home' })
    expect(JSON.stringify(hits[0])).not.toContain(home)
  })

  it('no over-broad line for ordinary values', async () => {
    const lines: string[] = []
    const log = { info() {}, error() {}, warn: (m: string) => { lines.push(m) } }
    k = await createKernel({ dataDir, plugins: [probe], home, env: { GNUPGHOME: join(work, 'gpg') }, log, secrets: { osBackend: false } })
    expect(lines.filter(m => m.includes('covers home or root'))).toEqual([])
  })
})
