import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRoots, persistenceRoots, resolveToolPath } from '../lib/fs/paths'
import { decide, defaultRules, PermissionGate, type DecideEnv, type PermissionRequest } from './permissionGate'
import { parseRule, type Rule, type RuleSpec } from '../lib/permissions/rules'
import type { SandboxStatus } from '../protocol/index'
import { Sessions, type SessionInfo } from './sessions'
import type { KernelEvent } from '../protocol/index'
import { createKernel, type Kernel } from './kernel'
import type { Plugin } from './pluginHost'
import { NO_SANDBOX } from '../../test/sandboxStub'

const FULL: SandboxStatus = { level: 'full', missing: [], autoDegraded: false }
/** 03 的判定表默认在完整沙箱下跑(auto 不降级),没有用户规则 */
const layered = { rules: [] as Rule[], sandbox: FULL, allowUnsandboxedAuto: false }
const rules = (...specs: RuleSpec[]): Rule[] => specs.map((s, i) => {
  const r = parseRule(s, i)
  if ('reason' in r) throw new Error(`bad rule ${s.rule}`)
  return r
})

describe('decide (table)', () => {
  const home = '/h'
  const dataDir = '/h/.myFlowForge/mff-ai'
  const spillDir = `${dataDir}/sessions/s1/spill`
  const env: DecideEnv = { roots: credentialRoots(home, 'linux', {}), persistence: persistenceRoots(home, 'linux'), dataDir, spillDir, platform: 'linux', home, ...layered }
  const ask: SessionInfo = { sessionId: 's1', cwd: '/h/repo', approvalMode: 'ask', origin: 'app' }
  const auto: SessionInfo = { ...ask, approvalMode: 'auto' }
  const atHome: SessionInfo = { ...ask, cwd: home }
  const noCwd: SessionInfo = { sessionId: 's1', approvalMode: 'auto', origin: 'app' }
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
    ['read ~/.qoder/.auth/x, cwd = home', req('read', '/h/.qoder/.auth/x'), atHome, 'deny'],
    ['write ~/.qoder/.auth/x, cwd = home', req('write', '/h/.qoder/.auth/x'), atHome, 'deny'],
    ['read ~/.qoder/settings.json, cwd = home', req('read', '/h/.qoder/settings.json'), atHome, 'allow'],
    ['read ~/.qoder/settings.json, cwd elsewhere', req('read', '/h/.qoder/settings.json'), ask, 'deny'],
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
    const w: DecideEnv = { roots: credentialRoots('C:\\Users\\u', 'win32', {}), persistence: persistenceRoots('C:\\Users\\u', 'win32'), dataDir: 'C:\\Users\\u\\.mff', platform: 'win32', home: 'C:\\Users\\u', ...layered }
    const s: SessionInfo = { sessionId: 's1', cwd: 'C:\\repo', approvalMode: 'auto', origin: 'app' }
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
    const w: DecideEnv = { roots: credentialRoots('C:\\Users\\u', 'win32', {}), persistence: persistenceRoots('C:\\Users\\u', 'win32'), dataDir: 'C:\\Users\\u\\.mff', platform: 'win32', home: 'C:\\Users\\u', ...layered }
    const s: SessionInfo = { sessionId: 's1', cwd: 'C:\\repo', approvalMode: 'auto', origin: 'app' }
    expect(decide(req('read', 'c:\\REPO\\x'), s, w)).toBe('allow')
    for (const p of ['D:\\x', '\\\\server\\share\\x', '\\\\?\\C:\\repo\\x', 'C:\\repo\\a.txt:stream'])
      expect(decide(req('write', p), s, w)).toBe('deny')
  })
})

describe('decide: layered rules (Review Focus 3)', () => {
  const home = '/h'
  const dataDir = '/h/.myFlowForge/mff-ai'
  const base: DecideEnv = { roots: credentialRoots(home, 'linux', {}), persistence: persistenceRoots(home, 'linux'), dataDir, platform: 'linux', home, ...layered }
  const repo: SessionInfo = { sessionId: 's1', cwd: '/h/repo', approvalMode: 'ask', origin: 'app' }
  const atHome: SessionInfo = { ...repo, cwd: home }
  const auto: SessionInfo = { ...repo, approvalMode: 'auto' }
  const req = (action: string, resource: string): PermissionRequest => ({ actor: 'tools', action, resource, sessionId: 's1' })
  const with_ = (...specs: RuleSpec[]): DecideEnv => ({ ...base, rules: rules(...specs) })

  it('user allow rules cannot loosen hard denies', () => {
    expect(decide(req('read', '/h/.ssh/id_ed25519'), atHome, with_({ effect: 'allow', rule: 'read(~/.ssh/**)' }))).toBe('deny')
    expect(decide(req('write', '/h/repo/.git/hooks/pre-commit'), repo, with_({ effect: 'allow', rule: 'write(.git/**)' }))).toBe('deny')
    expect(decide(req('write', '/elsewhere/x'), repo, with_({ effect: 'allow', rule: 'write(/elsewhere/**)' }))).toBe('deny')
    expect(decide(req('write', '/h/.zshrc'), atHome, with_({ effect: 'allow', rule: 'write(~/.zshrc)' }))).toBe('deny')
    expect(decide(req('read', `${dataDir}/token`), atHome, with_({ effect: 'allow', rule: `read(${dataDir}/**)` }))).toBe('deny')
    expect(decide(req('read', '/etc/passwd'), { ...repo, cwd: '/' }, with_({ effect: 'allow', rule: 'read(/**)' }))).toBe('deny') // R18
    expect(decide(req('read', 'relative.txt'), repo, with_({ effect: 'allow', rule: 'read(**)' }))).toBe('deny')
  })

  it('GNUPGHOME relocated outside home: a user allow on it is still denied', () => {
    const env = { ...with_({ effect: 'allow', rule: 'read(/t/gpg/**)' }), roots: credentialRoots(home, 'linux', { GNUPGHOME: '/t/gpg' }) }
    expect(decide(req('read', '/t/gpg/pubring.kbx'), repo, env)).toBe('deny')
    expect(decide(req('read', '/t/gpg/pubring.kbx'), repo, with_({ effect: 'allow', rule: 'read(/t/gpg/**)' }))).toBe('allow')
  })

  it('a user deny beats the default allow; a user allow beats the default deny (reads only)', () => {
    const env = with_({ effect: 'deny', rule: 'write(src/gen/**)' })
    expect(decide(req('write', '/h/repo/src/gen/a.ts'), repo, env)).toBe('deny')
    expect(decide(req('write', '/h/repo/src/a.ts'), repo, env)).toBe('allow')
    expect(decide(req('read', '/h/repo/src/gen/a.ts'), repo, env)).toBe('allow')
    const lib = with_({ effect: 'allow', rule: 'read(/opt/lib/**)' })
    expect(decide(req('read', '/opt/lib/x.ts'), repo, lib)).toBe('allow')
    expect(decide(req('read', '/opt/other/x.ts'), repo, lib)).toBe('deny')
    expect(decide(req('write', '/opt/lib/x.ts'), repo, with_({ effect: 'allow', rule: 'write(/opt/lib/**)' }))).toBe('deny')
  })

  it('user ask and deny > ask > allow within the user layer', () => {
    expect(decide(req('write', '/h/repo/package.json'), repo, with_({ effect: 'ask', rule: 'write(package.json)' }))).toBe('ask')
    const mixed = with_({ effect: 'allow', rule: 'read(/opt/**)' }, { effect: 'ask', rule: 'read(/opt/a/**)' }, { effect: 'deny', rule: 'read(/opt/a/b)' })
    expect(decide(req('read', '/opt/x'), repo, mixed)).toBe('allow')
    expect(decide(req('read', '/opt/a/x'), repo, mixed)).toBe('ask')
    expect(decide(req('read', '/opt/a/b'), repo, mixed)).toBe('deny')
  })

  it('a session without a cwd is denied reads and writes even with a matching allow', () => {
    const noCwd: SessionInfo = { sessionId: 's1', approvalMode: 'auto', origin: 'app' }
    expect(decide(req('read', '/opt/x'), noCwd, with_({ effect: 'allow', rule: 'read(/opt/**)' }))).toBe('deny')
  })

  it('exec: user rules first, then the mode default', () => {
    const env = with_({ effect: 'deny', rule: 'shell(git push*)' }, { effect: 'ask', rule: 'shell(rm *)' }, { effect: 'allow', rule: 'shell(npm test)' })
    expect(decide(req('exec', 'git push origin main'), auto, env)).toBe('deny')
    expect(decide(req('exec', 'ls && git push'), auto, env)).toBe('deny')
    expect(decide(req('exec', 'rm -rf build'), auto, env)).toBe('ask')
    expect(decide(req('exec', 'npm test'), repo, env)).toBe('allow')
    expect(decide(req('exec', 'npm test; ls'), repo, env)).toBe('ask')
    expect(decide(req('exec', 'ls'), auto, env)).toBe('allow')
    expect(decide({ actor: 'tools', action: 'exec', resource: 'npm test' }, undefined, env)).toBe('deny')
  })

  it('auto degrades to ask at level none unless allowUnsandboxedAuto; partial still auto-allows', () => {
    const none: SandboxStatus = { level: 'none', missing: ['platform'], autoDegraded: true }
    const partial: SandboxStatus = { level: 'partial', missing: ['netns'], autoDegraded: false }
    expect(decide(req('exec', 'ls'), auto, { ...base, sandbox: none })).toBe('ask')
    expect(decide(req('exec', 'ls'), auto, { ...base, sandbox: none, allowUnsandboxedAuto: true })).toBe('allow')
    expect(decide(req('exec', 'ls'), auto, { ...base, sandbox: partial })).toBe('allow')
    expect(decide(req('exec', 'npm test'), auto, { ...with_({ effect: 'allow', rule: 'shell(npm test)' }), sandbox: none })).toBe('allow')
  })

  it('defaultRules lists the per-session defaults', () => {
    const none: SandboxStatus = { level: 'none', missing: ['platform'], autoDegraded: true }
    expect(defaultRules(repo, FULL, false)).toEqual(['allow read(/h/repo/**)', 'allow write(/h/repo/**)', 'ask shell(*)'])
    expect(defaultRules(auto, FULL, false)).toEqual(['allow read(/h/repo/**)', 'allow write(/h/repo/**)', 'allow shell(*)'])
    expect(defaultRules(auto, none, false)[2]).toBe('ask shell(*)')
    expect(defaultRules(auto, none, true)[2]).toBe('allow shell(*)')
    expect(defaultRules({ sessionId: 's', approvalMode: 'auto', origin: 'app' }, FULL, false)).toEqual(['allow shell(*)'])
    expect(defaultRules(undefined, FULL, false)).toEqual(['allow read(<cwd>/**)', 'allow write(<cwd>/**)', '<mode> shell(*)'])
  })

  it('I1: a cwd or home with glob characters does not widen a user relative / ~ rule', () => {
    const star: SessionInfo = { ...repo, cwd: '/h/a*' }
    const lib = with_({ effect: 'allow', rule: 'read(lib/**)' })
    expect(decide(req('read', '/h/aX/lib/x'), star, lib)).toBe('deny')
    expect(decide(req('read', '/h/aOTHER/lib/x'), star, lib)).toBe('deny')
    expect(decide(req('read', '/h/a*/lib/x'), star, lib)).toBe('allow')
    const q: SessionInfo = { ...repo, cwd: '/h/w?rk' }
    expect(decide(req('read', '/h/w0rk/lib/x'), q, lib)).toBe('deny')
    expect(decide(req('read', '/h/w?rk/lib/x'), q, lib)).toBe('allow')
    // 用户自己写的通配符照常生效
    expect(decide(req('read', '/h/w?rk/lib2/x'), q, with_({ effect: 'allow', rule: 'read(li?2/**)' }))).toBe('allow')
    const odd: DecideEnv = { ...with_({ effect: 'allow', rule: 'read(~/shared/**)' }), home: '/u/h*' }
    expect(decide(req('read', '/u/hX/shared/a'), repo, odd)).toBe('deny')
    expect(decide(req('read', '/u/h*/shared/a'), repo, odd)).toBe('allow')
  })

  it('M5: defaultRules lists no read / write defaults for a root-like cwd', () => {
    expect(defaultRules({ ...repo, cwd: '/' }, FULL, false)).toEqual(['ask shell(*)'])
  })

  it('a cwd with glob characters does not widen the default allow', () => {
    const odd: SessionInfo = { ...repo, cwd: '/h/a?b' }
    expect(decide(req('read', '/h/a?b/x'), odd, base)).toBe('allow')
    expect(decide(req('read', '/h/aXb/x'), odd, base)).toBe('deny')
    expect(decide(req('read', '/h/a(b/x'), { ...repo, cwd: '/h/a(b' }, base)).toBe('allow')
  })
})

describe('decide: delegation can only narrow (04 spec §6)', () => {
  const home = '/h'
  const dataDir = '/h/.myFlowForge/mff-ai'
  const base: DecideEnv = { roots: credentialRoots(home, 'linux', {}), persistence: persistenceRoots(home, 'linux'), dataDir, platform: 'linux', home, ...layered }
  const session = (approvalMode: 'ask' | 'auto'): SessionInfo => ({ sessionId: 's1', cwd: '/h/repo', approvalMode, origin: 'app' })
  const statusOf = (level: SandboxStatus['level']): SandboxStatus => ({ level, missing: level === 'full' ? [] : ['platform'], autoDegraded: false })
  const ALLOW = { effect: 'allow', rule: 'shell(codex)' } as const

  type Row = {
    level: SandboxStatus['level']
    mode: 'ask' | 'auto'
    flag?: boolean
    rules?: RuleSpec[]
    unsandboxed?: boolean
    mustAsk?: boolean
    want: 'allow' | 'ask' | 'deny'
  }
  const table: Row[] = [
    // own / wrapped: not wider than the session
    { level: 'full', mode: 'auto', unsandboxed: false, want: 'allow' },
    { level: 'partial', mode: 'auto', unsandboxed: false, want: 'allow' },
    { level: 'full', mode: 'auto', flag: true, unsandboxed: false, want: 'allow' },
    // isolation none in a sandboxed session: wider, a person has to allow it
    { level: 'full', mode: 'auto', unsandboxed: true, want: 'ask' },
    { level: 'partial', mode: 'auto', unsandboxed: true, want: 'ask' },
    { level: 'full', mode: 'auto', flag: true, unsandboxed: true, want: 'ask' },
    { level: 'partial', mode: 'auto', flag: true, unsandboxed: true, want: 'ask' },
    { level: 'full', mode: 'auto', rules: [ALLOW], unsandboxed: true, want: 'ask' },
    { level: 'partial', mode: 'auto', rules: [ALLOW], unsandboxed: true, want: 'ask' },
    { level: 'full', mode: 'auto', flag: true, rules: [ALLOW], unsandboxed: true, want: 'ask' },
    { level: 'full', mode: 'ask', rules: [ALLOW], unsandboxed: true, want: 'ask' },
    // session none: same footing as shell
    { level: 'none', mode: 'auto', unsandboxed: false, want: 'ask' },
    { level: 'none', mode: 'auto', unsandboxed: true, want: 'ask' },
    { level: 'none', mode: 'auto', flag: true, unsandboxed: false, want: 'allow' },
    { level: 'none', mode: 'auto', flag: true, unsandboxed: true, want: 'allow' },
    { level: 'none', mode: 'auto', rules: [ALLOW], unsandboxed: true, want: 'allow' },
    // ask mode asks by default whatever the isolation
    { level: 'full', mode: 'ask', unsandboxed: false, want: 'ask' },
    { level: 'partial', mode: 'ask', flag: true, unsandboxed: false, want: 'ask' },
    { level: 'none', mode: 'ask', unsandboxed: false, want: 'ask' },
    { level: 'none', mode: 'ask', flag: true, unsandboxed: true, want: 'ask' },
    // a user allow still beats the mode default when it doesn't widen anything (05 semantics)
    { level: 'full', mode: 'ask', rules: [ALLOW], unsandboxed: false, want: 'allow' },
    // other tools don't send the flag: session level decides, as in 05
    { level: 'full', mode: 'auto', want: 'allow' },
    { level: 'none', mode: 'auto', want: 'ask' },
    { level: 'none', mode: 'auto', flag: true, want: 'allow' },
  ]
  it.each(table)('$level $mode flag=$flag unsandboxed=$unsandboxed rules=$rules.0.rule → $want', ({ level, mode, flag, rules: specs, unsandboxed, want }) => {
    const env: DecideEnv = { ...base, sandbox: statusOf(level), allowUnsandboxedAuto: flag ?? false, rules: rules(...(specs ?? [])) }
    expect(decide({ actor: 'tools', action: 'exec', resource: 'codex', sessionId: 's1', unsandboxed }, session(mode), env)).toBe(want)
  })

  const LEVELS: SandboxStatus['level'][] = ['full', 'partial', 'none']
  const MODES = ['ask', 'auto'] as const
  const FLAGS = [false, true]
  const everywhere = LEVELS.flatMap(level => MODES.flatMap(mode => FLAGS.map(flag => [level, mode, flag] as const)))

  it.each(everywhere)('mustAsk asks at %s / %s / allowUnsandboxedAuto=%s, also with allow shell(codex)', (level, mode, flag) => {
    for (const specs of [[], [ALLOW]] as RuleSpec[][]) {
      for (const unsandboxed of [undefined, false, true]) {
        const env: DecideEnv = { ...base, sandbox: statusOf(level), allowUnsandboxedAuto: flag, rules: rules(...specs) }
        expect(decide({ actor: 'tools', action: 'exec', resource: 'codex', sessionId: 's1', unsandboxed, mustAsk: true }, session(mode), env)).toBe('ask')
      }
    }
  })

  it.each(everywhere)('deny shell(codex*) denies at %s / %s / allowUnsandboxedAuto=%s, whatever the request says', (level, mode, flag) => {
    const env: DecideEnv = { ...base, sandbox: statusOf(level), allowUnsandboxedAuto: flag, rules: rules({ effect: 'deny', rule: 'shell(codex*)' }, ALLOW) }
    for (const extra of [{}, { unsandboxed: false }, { unsandboxed: true }, { mustAsk: true }, { key: 'executor:codex:rw' }])
      expect(decide({ actor: 'tools', action: 'exec', resource: 'codex', sessionId: 's1', ...extra }, session(mode), env)).toBe('deny')
  })

  it.each(everywhere)('ask shell(codex) asks at %s / %s / allowUnsandboxedAuto=%s', (level, mode, flag) => {
    const env: DecideEnv = { ...base, sandbox: statusOf(level), allowUnsandboxedAuto: flag, rules: rules({ effect: 'ask', rule: 'shell(codex)' }) }
    for (const unsandboxed of [undefined, false, true])
      expect(decide({ actor: 'tools', action: 'exec', resource: 'codex', sessionId: 's1', unsandboxed }, session(mode), env)).toBe('ask')
  })

  it('a rule for one executor does not reach the other', () => {
    const env: DecideEnv = { ...base, rules: rules({ effect: 'deny', rule: 'shell(codex*)' }) }
    expect(decide({ actor: 'tools', action: 'exec', resource: 'qoder', sessionId: 's1', unsandboxed: false }, session('auto'), env)).toBe('allow')
  })

  it('no session is still a deny, whatever the request says', () => {
    expect(decide({ actor: 'tools', action: 'exec', resource: 'codex', mustAsk: true }, undefined, base)).toBe('deny')
    expect(decide({ actor: 'tools', action: 'exec', resource: 'codex', unsandboxed: false }, undefined, { ...base, allowUnsandboxedAuto: true })).toBe('deny')
  })

  it('the flags change nothing for reads and writes: hard denies and the default stay', () => {
    const s = session('auto')
    for (const extra of [{ unsandboxed: true }, { unsandboxed: false }, { mustAsk: true }]) {
      expect(decide({ actor: 'tools', action: 'read', resource: '/h/repo/a', sessionId: 's1', ...extra }, s, base)).toBe('allow')
      expect(decide({ actor: 'tools', action: 'write', resource: '/h/repo/a', sessionId: 's1', ...extra }, s, base)).toBe('allow')
      expect(decide({ actor: 'tools', action: 'read', resource: '/h/.ssh/id', sessionId: 's1', ...extra }, s, base)).toBe('deny')
      expect(decide({ actor: 'tools', action: 'write', resource: '/tmp/x', sessionId: 's1', ...extra }, s, base)).toBe('deny')
    }
  })

  it('C12: deny read(**) and deny write(**) stop the requests delegation adds for its cwd', () => {
    const s = session('auto')
    const noReads: DecideEnv = { ...base, rules: rules({ effect: 'deny', rule: 'read(**)' }) }
    const noWrites: DecideEnv = { ...base, rules: rules({ effect: 'deny', rule: 'write(**)' }) }
    expect(decide({ actor: 'tools', action: 'read', resource: '/h/repo', sessionId: 's1' }, s, noReads)).toBe('deny')
    expect(decide({ actor: 'tools', action: 'write', resource: '/h/repo', sessionId: 's1' }, s, noWrites)).toBe('deny')
    expect(decide({ actor: 'tools', action: 'read', resource: '/h/repo', sessionId: 's1' }, s, noWrites)).toBe('allow')
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

  const gateFor = (
    cwd: string, approvalMode: 'ask' | 'auto' = 'ask', env: NodeJS.ProcessEnv = {}, specs: RuleSpec[] = [],
    o: { sandbox?: SandboxStatus; allowUnsandboxedAuto?: boolean; asked?: (string | undefined)[] } = {},
  ) => {
    const sessions = new Sessions(dataDir)
    const ev: KernelEvent = { seq: 1, ts: 0, type: 'session.created', sessionId: 's1', payload: { cwd: realpathSync.native(cwd), approvalMode } }
    sessions.observe(ev)
    const permissions = () => ({ rules: rules(...specs), config: { allowUnsandboxedAuto: o.allowUnsandboxedAuto ?? false } })
    const sandbox = (sessionId?: string) => {
      o.asked?.push(sessionId)
      return o.sandbox ?? FULL
    }
    return { gate: new PermissionGate({ sessions, home, dataDir, platform: process.platform, env, permissions, sandbox }), cwd: realpathSync.native(cwd) }
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

  it('Review Focus 3: GNUPGHOME=<tmp>/gpg with a user allow read(<tmp>/gpg/**) is still denied', () => {
    mkdirSync(join(outside, 'gpg'))
    writeFileSync(join(outside, 'gpg', 'x'), 'k')
    const real = realpathSync.native(outside)
    const { gate } = gateFor(join(home, 'repo'), 'auto', { GNUPGHOME: join(outside, 'gpg') }, [{ effect: 'allow', rule: `read(${outside}/**)` }])
    expect(check(gate, 'read', resolveToolPath(real, 'gpg/x'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(real, 'secret'))).toBe('allow') // 同一条 allow 放开了别的文件(模式经 realpath 对上 /private/var)
  })

  it('a user deny in the real gate blocks a file the default would allow', () => {
    const { gate, cwd } = gateFor(join(home, 'repo'), 'auto', {}, [{ effect: 'deny', rule: 'read(src/gen/**)' }])
    expect(check(gate, 'read', resolveToolPath(cwd, 'src/gen/a.ts'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, 'src/a.ts'))).toBe('allow')
  })

  it('~/.qoder: .auth is denied even when absent, the rest follows the default path logic', () => {
    mkdirSync(join(home, '.qoder'))
    writeFileSync(join(home, '.qoder', 'settings.json'), '{}')
    const atHome = gateFor(home)
    expect(check(atHome.gate, 'read', resolveToolPath(atHome.cwd, '.qoder/.auth/x'))).toBe('deny')
    expect(check(atHome.gate, 'write', resolveToolPath(atHome.cwd, '.qoder/.auth/x'))).toBe('deny')
    expect(check(atHome.gate, 'read', resolveToolPath(atHome.cwd, '.qoder/settings.json'))).toBe('allow')
    const inRepo = gateFor(join(home, 'repo'))
    expect(check(inRepo.gate, 'read', resolveToolPath(inRepo.cwd, '../.qoder/settings.json'))).toBe('deny') // cwd 外,照常兜底拒绝
    expect(check(inRepo.gate, 'read', resolveToolPath(inRepo.cwd, '../.qoder/.auth/x'))).toBe('deny')
  })

  it('a user allow cannot open ~/.qoder/.auth', () => {
    const { gate, cwd } = gateFor(home, 'auto', {}, [{ effect: 'allow', rule: 'read(~/.qoder/**)' }])
    expect(check(gate, 'read', resolveToolPath(cwd, '.qoder/.auth/x'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, '.qoder/settings.json'))).toBe('allow')
  })

  it('QODER_CONFIG_DIR hides the whole relocated directory', () => {
    mkdirSync(join(outside, 'q'))
    writeFileSync(join(outside, 'q', 'state'), 'k')
    const { gate, cwd } = gateFor(outside, 'auto', { QODER_CONFIG_DIR: join(outside, 'q') })
    expect(check(gate, 'read', resolveToolPath(cwd, 'q/state'))).toBe('deny')
    expect(check(gate, 'write', resolveToolPath(cwd, 'q/new'))).toBe('deny')
    expect(check(gate, 'read', resolveToolPath(cwd, 'secret'))).toBe('allow')
  })

  it('the per-request flags reach the session sandbox level through check', () => {
    const exec = (extra: object) => ({ actor: 'plugin:tools', action: 'exec', resource: 'codex', sessionId: 's1', ...extra })
    const full = gateFor(join(home, 'repo'), 'auto', {}, [], { allowUnsandboxedAuto: true }).gate
    expect(full.check(exec({ unsandboxed: false }))).toBe('allow')
    expect(full.check(exec({ unsandboxed: true }))).toBe('ask')
    expect(full.check(exec({ mustAsk: true }))).toBe('ask')
    expect(full.checkMany([exec({ unsandboxed: false }), exec({ unsandboxed: true }), exec({ mustAsk: true })])).toEqual(['allow', 'ask', 'ask'])
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

  describe('Task 11: the gate reads the sandbox service', () => {
    const NONE: SandboxStatus = { level: 'none', missing: ['platform'], autoDegraded: true }
    const PARTIAL: SandboxStatus = { level: 'partial', missing: ['proxy'], autoDegraded: false }
    const repo = () => join(home, 'repo')

    it('auto at level none → ask; allowUnsandboxedAuto → allow; partial / full → allow', () => {
      expect(check(gateFor(repo(), 'auto', {}, [], { sandbox: NONE }).gate, 'exec', 'ls')).toBe('ask')
      expect(check(gateFor(repo(), 'auto', {}, [], { sandbox: NONE, allowUnsandboxedAuto: true }).gate, 'exec', 'ls')).toBe('allow')
      expect(check(gateFor(repo(), 'auto', {}, [], { sandbox: PARTIAL }).gate, 'exec', 'ls')).toBe('allow')
      expect(check(gateFor(repo(), 'auto', {}, [], { sandbox: FULL }).gate, 'exec', 'ls')).toBe('allow')
      // ask 会话不受级别影响
      expect(check(gateFor(repo(), 'ask', {}, [], { sandbox: FULL }).gate, 'exec', 'ls')).toBe('ask')
    })

    it('a user allow shell(npm test) at level none runs without approval', () => {
      const { gate } = gateFor(repo(), 'auto', {}, [{ effect: 'allow', rule: 'shell(npm test)' }], { sandbox: NONE })
      expect(check(gate, 'exec', 'npm test')).toBe('allow')
      expect(check(gate, 'exec', 'npm run build')).toBe('ask')
    })

    it('a user ask shell(git push*) asks even in auto + full', () => {
      const { gate } = gateFor(repo(), 'auto', {}, [{ effect: 'ask', rule: 'shell(git push*)' }], { sandbox: FULL })
      expect(check(gate, 'exec', 'git push origin main')).toBe('ask')
      expect(check(gate, 'exec', 'git status')).toBe('allow')
    })

    it('reads / writes do not depend on the level', () => {
      const { gate, cwd } = gateFor(repo(), 'auto', {}, [], { sandbox: NONE })
      expect(check(gate, 'write', resolveToolPath(cwd, 'a.txt'))).toBe('allow')
      expect(check(gate, 'read', resolveToolPath(cwd, 'a.txt'))).toBe('allow')
    })

    it('the level is asked per session (a proxy failure is per session)', () => {
      const asked: (string | undefined)[] = []
      const { gate } = gateFor(repo(), 'auto', {}, [], { asked })
      check(gate, 'exec', 'ls')
      expect(asked).toEqual(['s1'])
      asked.length = 0
      gate.defaults('s1')
      expect(asked).toEqual(['s1'])
    })

    it('defaults() reflects the degrade', () => {
      expect(gateFor(repo(), 'auto', {}, [], { sandbox: NONE }).gate.defaults('s1').at(-1)).toBe('ask shell(*)')
      expect(gateFor(repo(), 'auto', {}, [], { sandbox: NONE, allowUnsandboxedAuto: true }).gate.defaults('s1').at(-1)).toBe('allow shell(*)')
      expect(gateFor(repo(), 'auto', {}, [], { sandbox: FULL }).gate.defaults('s1').at(-1)).toBe('allow shell(*)')
    })
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
    k = await createKernel({ sandbox: NO_SANDBOX, dataDir, plugins: [probe], home, env, secrets: { osBackend: false } })
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

  it('Task 11: the kernel gate reads the sandbox level (auto degrades at none, not at full)', async () => {
    const execIn = async (detect: () => { level: 'full' | 'none'; missing: [] | ['platform'] }) => {
      k = await createKernel({ sandbox: { detect, upstream: null }, dataDir, plugins: [probe], home, secrets: { osBackend: false } })
      const { sessionId } = await k.handle('session.create', { commandId: 'c1', cwd: work, approvalMode: 'auto' }) as { sessionId: string }
      const d = gate!.check({ actor: 'plugin:tools', action: 'exec', resource: 'ls', sessionId })
      await k.close()
      k = undefined
      return d
    }
    expect(await execIn(() => ({ level: 'none', missing: ['platform'] }))).toBe('ask')
    expect(await execIn(() => ({ level: 'full', missing: [] }))).toBe('allow')
  })

  it('logs one line naming an over-broad variable, without its value', async () => {
    const lines: [string, unknown][] = []
    const log = { info() {}, error() {}, warn: (m: string, d?: unknown) => { lines.push([m, d]) } }
    k = await createKernel({ sandbox: NO_SANDBOX, dataDir, plugins: [probe], home, env: { CODEX_HOME: home, DOCKER_CONFIG: '/', GNUPGHOME: join(work, 'gpg') }, log, secrets: { osBackend: false } })
    const hits = lines.filter(([m]) => m.includes('covers home or root'))
    expect(hits).toHaveLength(1)
    expect(hits[0][1]).toEqual({ vars: 'DOCKER_CONFIG:root,CODEX_HOME:home' })
    expect(JSON.stringify(hits[0])).not.toContain(home)
  })

  it('no over-broad line for ordinary values', async () => {
    const lines: string[] = []
    const log = { info() {}, error() {}, warn: (m: string) => { lines.push(m) } }
    k = await createKernel({ sandbox: NO_SANDBOX, dataDir, plugins: [probe], home, env: { GNUPGHOME: join(work, 'gpg') }, log, secrets: { osBackend: false } })
    expect(lines.filter(m => m.includes('covers home or root'))).toEqual([])
  })
})
