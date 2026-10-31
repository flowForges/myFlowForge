import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { canonicalRoots, credentialRoots, isCredentialPath, isInside, isRootLike, OUTSIDE, overbroadRelocations, PERSISTENCE_FILES, persistenceRoots, RELOCATED_ENV, relocatedCredentialRoots, resolveToolPath, snapshotEnv } from './paths'

let base: string
let cwd: string
let outside: string
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mffai-paths-')))
  cwd = join(base, 'cwd')
  outside = join(base, 'outside')
  mkdirSync(cwd)
  mkdirSync(outside)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const P = process.platform

describe('resolveToolPath (real tree)', () => {
  it('a non-existent nested path stays inside cwd', () => {
    const r = resolveToolPath(cwd, 'a/b/c.txt')
    expect(r).toBe(join(cwd, 'a', 'b', 'c.txt'))
    expect(isInside(r, cwd, P)).toBe(true)
  })

  it('.. escapes are outside', () => {
    const r = resolveToolPath(cwd, '../outside/x')
    expect(r).toBe(join(outside, 'x'))
    expect(isInside(r, cwd, P)).toBe(false)
  })

  it('symlink escape to a sibling dir with a non-existent tail is outside and creates nothing', () => {
    symlinkSync(outside, join(cwd, 'link'), 'dir')
    const r = resolveToolPath(cwd, 'link/new/x.txt')
    expect(r).toBe(join(outside, 'new', 'x.txt'))
    expect(isInside(r, cwd, P)).toBe(false)
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })

  it('a dangling symlink is outside (the write would land at its target)', () => {
    symlinkSync(join(outside, 'nothing.txt'), join(cwd, 'dang'))
    expect(isInside(resolveToolPath(cwd, 'dang'), cwd, P)).toBe(false)
    expect(isInside(resolveToolPath(cwd, 'dang/x'), cwd, P)).toBe(false)
  })

  it('a symlink loop is outside', () => {
    symlinkSync(join(cwd, 'loop'), join(cwd, 'loop'))
    expect(isInside(resolveToolPath(cwd, 'loop/x'), cwd, P)).toBe(false)
    expect(isInside(resolveToolPath(cwd, 'loop'), cwd, P)).toBe(false)
  })

  it('an in-tree symlink is inside', () => {
    mkdirSync(join(cwd, 'real'))
    writeFileSync(join(cwd, 'real', 'f'), 'x')
    symlinkSync(join(cwd, 'real'), join(cwd, 'alias'), 'dir')
    expect(resolveToolPath(cwd, 'alias/f')).toBe(join(cwd, 'real', 'f'))
  })

  it('NUL in the path returns the sentinel, which is never inside', () => {
    const r = resolveToolPath(cwd, 'a\0b')
    expect(r).toContain('\0')
    expect(isInside(r, cwd, P)).toBe(false)
    expect(isInside(r, '/', 'linux')).toBe(false)
    expect(isCredentialPath(r, [], P)).toBe(true) // 失败即拒
  })
})

describe('resolveToolPath: lstat errors', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable component fails closed (EACCES is not "missing")', () => {
    const locked = join(cwd, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect(resolveToolPath(cwd, 'locked/x/y')).toBe(OUTSIDE)
    } finally {
      chmodSync(locked, 0o755)
    }
  })
  it('an injected exists that throws fails closed', () => {
    const exists = () => { throw Object.assign(new Error('io'), { code: 'EIO' }) }
    expect(resolveToolPath('/repo', 'x', { platform: 'linux', exists, realpath: p => p })).toBe(OUTSIDE)
  })
})

describe('canonicalRoots: dangling credential links', () => {
  it('adds the target of a dangling ~/.ssh link, resolved as far as possible', () => {
    const keys = join(cwd, 'keys') // 还不存在
    symlinkSync(keys, join(base, '.ssh'))
    const roots = canonicalRoots(credentialRoots(base, P, {}))
    expect(isCredentialPath(resolveToolPath(cwd, 'keys/authorized_keys'), roots, P)).toBe(true)
    expect(isCredentialPath(resolveToolPath(cwd, 'other.txt'), roots, P)).toBe(false)
  })
  it('follows a chain of dangling links and a relative link', () => {
    symlinkSync('outside/hop', join(base, '.aws')) // 相对链接
    symlinkSync(join(cwd, 'creds'), join(outside, 'hop')) // 第二跳,目标不存在
    const roots = canonicalRoots(credentialRoots(base, P, {}))
    expect(isCredentialPath(resolveToolPath(cwd, 'creds/config'), roots, P)).toBe(true)
  })
})

describe('resolveToolPath (win32, injected fs)', () => {
  const key = (p: string) => { const n = win32.normalize(p).toLowerCase(); return n.length > 3 ? n.replace(/\\+$/, '') : n }
  const tree = new Set(['c:\\', 'c:\\repo', 'c:\\repo\\x', 'd:\\', 'd:\\x'])
  const opts = {
    platform: 'win32' as const,
    exists: (p: string) => tree.has(key(p)),
    realpath: (p: string) => win32.normalize(p),
  }
  const inRepo = (p: string) => isInside(resolveToolPath('C:\\repo', p, opts), 'C:\\repo', 'win32')

  it('is case-insensitive', () => {
    expect(isInside('c:\\REPO\\x', 'C:\\repo', 'win32')).toBe(true)
    expect(inRepo('c:\\REPO\\x')).toBe(true)
    expect(inRepo('sub\\new.txt')).toBe(true)
    expect(inRepo('sub/new.txt')).toBe(true)
  })
  it('another drive is outside', () => {
    expect(inRepo('D:\\x')).toBe(false)
    expect(inRepo('D:x')).toBe(false)
  })
  it('UNC, \\\\?\\ and \\\\.\\ forms are outside', () => {
    for (const p of ['\\\\server\\share\\x', '//server/share/x', '\\\\?\\C:\\repo\\x', '\\\\.\\C:\\repo\\x', '\\\\?\\UNC\\srv\\share\\x'])
      expect(inRepo(p)).toBe(false)
    expect(isInside('\\\\?\\C:\\repo\\x', 'C:\\repo', 'win32')).toBe(false)
  })
  it('an alternate data stream is outside', () => {
    expect(inRepo('C:\\repo\\a.txt:stream')).toBe(false)
    expect(inRepo('a.txt:stream')).toBe(false)
  })
  it('a component with a trailing dot or space is outside (Windows strips them)', () => {
    expect(inRepo('sub.\\x')).toBe(false)
    expect(inRepo('sub \\x')).toBe(false)
  })
  it('NUL is outside', () => {
    expect(inRepo('a\0b')).toBe(false)
  })
})

describe('isInside', () => {
  it('is segment-wise', () => {
    expect(isInside('/repo2/x', '/repo', 'linux')).toBe(false)
    expect(isInside('/repo', '/repo', 'linux')).toBe(true)
    expect(isInside('/repo/', '/repo', 'linux')).toBe(true)
    expect(isInside('/repo/a/b', '/repo/', 'linux')).toBe(true)
  })
  it('is case-sensitive on linux, insensitive on darwin', () => {
    expect(isInside('/Repo/x', '/repo', 'linux')).toBe(false)
    expect(isInside('/Repo/x', '/repo', 'darwin')).toBe(true)
  })
  it('a relative child is never inside', () => {
    expect(isInside('repo/x', '/repo', 'linux')).toBe(false)
  })
})

describe('credential blacklist', () => {
  it('lists the spec §10.1 roots under home', () => {
    const r = credentialRoots('/h', 'darwin', {})
    for (const rel of ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.azure', '.kube', '.docker', '.netrc',
      '.git-credentials', '.npmrc', '.pypirc', '.codex', '.claude', 'Library/Keychains'])
      expect(r).toContain(`/h/${rel}`)
  })
  it('adds %APPDATA% roots on win32', () => {
    const r = credentialRoots('C:\\Users\\u', 'win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })
    expect(r).toContain('C:\\Users\\u\\.ssh')
    expect(r).toContain('C:\\Users\\u\\.config\\gh')
    expect(r).toContain('C:\\Users\\u\\AppData\\Roaming\\gh')
    expect(r).toContain('C:\\Users\\u\\AppData\\Roaming\\gcloud')
  })
  it('matches case-insensitively on darwin and win32', () => {
    expect(isCredentialPath('/h/.SSH/id', credentialRoots('/h', 'darwin', {}), 'darwin')).toBe(true)
    expect(isCredentialPath('/h/.SSH/id', credentialRoots('/h', 'linux', {}), 'linux')).toBe(false)
    expect(isCredentialPath('/h/.ssh/id', credentialRoots('/h', 'linux', {}), 'linux')).toBe(true)
    expect(isCredentialPath('c:\\users\\U\\.SSH\\id', credentialRoots('C:\\Users\\u', 'win32', {}), 'win32')).toBe(true)
    expect(isCredentialPath('/h/.sshx', credentialRoots('/h', 'darwin', {}), 'darwin')).toBe(false)
    expect(isCredentialPath('/h/.netrc', credentialRoots('/h', 'darwin', {}), 'darwin')).toBe(true)
  })
  it('Unicode case folds (ſ → s, ß → ss) cannot dodge the blacklist on darwin / win32', () => {
    const bypass = ['.awſ/config', '.ſſh/authorized_keys', '.ßh/x', '.ſsh/x', '.git-credentialſ', 'Library/Keychainſ/x', '.AWſ/config']
    for (const rel of bypass) {
      expect(isCredentialPath(`/h/${rel}`, credentialRoots('/h', 'darwin', {}), 'darwin'), rel).toBe(true)
      expect(isCredentialPath(`C:\\Users\\u\\${rel.replace(/\//g, '\\')}`, credentialRoots('C:\\Users\\u', 'win32', {}), 'win32'), rel).toBe(true)
    }
    expect(isCredentialPath('/h/.awſ/config', credentialRoots('/h', 'linux', {}), 'linux')).toBe(false) // ext4 区分大小写:不同的目录
    // 容纳判断不受强折叠影响
    expect(isInside('/h/ſrc/x', '/h/src', 'darwin')).toBe(false)
  })
  it('darwin: the /System/Volumes/Data firmlink alias is collapsed', () => {
    const roots = credentialRoots('/Users/u', 'darwin', {})
    expect(isCredentialPath('/System/Volumes/Data/Users/u/.ssh/id', roots, 'darwin')).toBe(true)
    expect(isCredentialPath('/system/volumes/data/Users/u/.SSH/id', roots, 'darwin')).toBe(true)
    expect(isInside('/Users/u/.ssh/id', '/System/Volumes/Data/Users/u', 'darwin')).toBe(true)
    expect(isCredentialPath('/System/Volumes/Data/Users/u/.ssh/id', roots, 'linux')).toBe(false)
  })
  it('darwin: only real firmlinked dirs collapse; the bare prefix and /usr do not', () => {
    expect(isInside('/Users/x/f', '/System/Volumes/Data/Users/x', 'darwin')).toBe(true)
    expect(isInside('/usr/local/bin/x', '/System/Volumes/Data/usr/local', 'darwin')).toBe(true)
    expect(isInside('/private/etc/x', '/System/Volumes/Data', 'darwin')).toBe(false)
    expect(isInside('/usr/bin/x', '/System/Volumes/Data/usr', 'darwin')).toBe(false)
    expect(isInside('/usr/bin/x', '/System/Volumes/Data/usr/bin', 'darwin')).toBe(false)
    expect(isRootLike('/System/Volumes/Data', 'darwin')).toBe(true) // 数据卷根
    expect(isRootLike('/System/Volumes/Data', 'linux')).toBe(false)
    expect(isRootLike('/System/Volumes/Data/Users', 'darwin')).toBe(false)
    expect(isRootLike('/', 'darwin')).toBe(true)
    expect(isRootLike('C:\\', 'win32')).toBe(true)
    expect(isRootLike('C:\\repo', 'win32')).toBe(false)
  })
})

describe('env-relocated credential roots (spec §5.1)', () => {
  it('dir and file variables add their absolute value', () => {
    for (const name of ['GNUPGHOME', 'DOCKER_CONFIG', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'CLOUDSDK_CONFIG', 'AZURE_CONFIG_DIR',
      'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'NPM_CONFIG_USERCONFIG', 'NETRC'])
      expect(relocatedCredentialRoots({ [name]: '/w/x' }, 'linux'), name).toEqual(['/w/x'])
  })
  it('the table matches the spec', () => {
    const kinds = Object.fromEntries(RELOCATED_ENV.map(e => [e.name, e.kind]))
    expect(kinds).toEqual({
      GNUPGHOME: 'dir', DOCKER_CONFIG: 'dir', CODEX_HOME: 'dir', CLAUDE_CONFIG_DIR: 'dir', GH_CONFIG_DIR: 'dir', CLOUDSDK_CONFIG: 'dir', AZURE_CONFIG_DIR: 'dir',
      AWS_CONFIG_FILE: 'file', AWS_SHARED_CREDENTIALS_FILE: 'file', GOOGLE_APPLICATION_CREDENTIALS: 'file', NPM_CONFIG_USERCONFIG: 'file', NETRC: 'file',
      KUBECONFIG: 'list', XDG_CONFIG_HOME: 'xdg',
    })
  })
  it('a leading ~ / ~/ expands against home (gpg, npm, azure-cli expand it); ~user and other relative values are dropped', () => {
    expect(relocatedCredentialRoots({ GNUPGHOME: '~/k/gpg', NETRC: '~', AWS_CONFIG_FILE: '~user/x', AZURE_CONFIG_DIR: '~x' }, 'linux', '/h')).toEqual(['/h/k/gpg', '/h'])
    expect(relocatedCredentialRoots({ AWS_CONFIG_FILE: '~/.aws2' }, 'linux', '/h')).toEqual(['/h/.aws2'])
    expect(relocatedCredentialRoots({ KUBECONFIG: '~/k1:/b/k2' }, 'linux', '/h')).toEqual(['/h/k1', '/b/k2'])
    expect(relocatedCredentialRoots({ XDG_CONFIG_HOME: '~/cfg' }, 'linux', '/h')).toEqual(['/h/cfg/gh', '/h/cfg/gcloud'])
    expect(relocatedCredentialRoots({ GNUPGHOME: '~\\gpg', DOCKER_CONFIG: '~/d' }, 'win32', 'C:\\Users\\u')).toEqual(['C:\\Users\\u\\gpg', 'C:\\Users\\u\\d'])
    expect(relocatedCredentialRoots({ GNUPGHOME: '~\\gpg' }, 'linux', '/h')).toEqual([]) // posix 上 `~\` 不是家目录
    expect(credentialRoots('/h', 'linux', { GNUPGHOME: '~/work/keys/gpg' })).toContain('/h/work/keys/gpg')
    expect(relocatedCredentialRoots({ GNUPGHOME: '~/gpg' }, 'linux')).toEqual([]) // 没给 home 不展开
  })
  it('win32: the snapshot upper-cases names, and lookups are case-insensitive', () => {
    const snap = snapshotEnv({ GnupgHome: 'C:\\g', AppData: 'C:\\ad', Path: 'x' }, 'win32')
    expect(Object.keys(snap).sort()).toEqual(['APPDATA', 'GNUPGHOME', 'PATH'])
    expect(Object.isFrozen(snap)).toBe(true)
    for (const env of [snap, { GnupgHome: 'C:\\g', AppData: 'C:\\ad' }]) {
      const r = credentialRoots('C:\\Users\\u', 'win32', env)
      expect(r).toContain('C:\\g')
      expect(r).toContain('C:\\ad\\gh')
    }
    expect(snapshotEnv({ GnupgHome: '/g' }, 'linux')).toEqual({ GnupgHome: '/g' }) // posix 区分大小写
    expect(relocatedCredentialRoots(snapshotEnv({ GnupgHome: '/g' }, 'linux'), 'linux')).toEqual([])
  })
  it('a .. through a symlink lists both the literal and the physical location', () => {
    mkdirSync(join(base, 'a', 'b'), { recursive: true })
    mkdirSync(join(base, 'w'))
    symlinkSync(join(base, 'a', 'b'), join(base, 'w', 'link'), 'dir')
    const r = relocatedCredentialRoots({ GNUPGHOME: `${join(base, 'w', 'link')}/../gpg` }, P)
    expect(r).toHaveLength(2)
    expect(isCredentialPath(join(base, 'w', 'gpg', 'x'), r, P)).toBe(true)
    expect(isCredentialPath(join(base, 'a', 'gpg', 'x'), r, P)).toBe(true)
    expect(relocatedCredentialRoots({ GNUPGHOME: join(base, 'w', 'gpg') }, P)).toHaveLength(1)
  })
  it('overbroadRelocations names variables that cover home or the root, without paths', () => {
    expect(overbroadRelocations({ CODEX_HOME: '/h', DOCKER_CONFIG: '/', GNUPGHOME: '/h/x', XDG_CONFIG_HOME: '/h/cfg', KUBECONFIG: '/:/' }, '/h', 'linux'))
      .toEqual([{ name: 'DOCKER_CONFIG', covers: 'root' }, { name: 'CODEX_HOME', covers: 'home' }, { name: 'KUBECONFIG', covers: 'root' }])
    expect(overbroadRelocations({ NETRC: '~' }, '/h', 'linux')).toEqual([{ name: 'NETRC', covers: 'home' }])
    expect(overbroadRelocations({ CLAUDE_CONFIG_DIR: '/H' }, '/h', 'darwin')).toEqual([{ name: 'CLAUDE_CONFIG_DIR', covers: 'home' }])
    expect(overbroadRelocations({}, '/h', 'linux')).toEqual([])
  })
  it('relative and empty values are ignored', () => {
    expect(relocatedCredentialRoots({ GNUPGHOME: 'gpg', NETRC: '', DOCKER_CONFIG: './d', AWS_CONFIG_FILE: '~/.aws2', KUBECONFIG: '', XDG_CONFIG_HOME: 'cfg' }, 'linux')).toEqual([])
    expect(relocatedCredentialRoots({}, 'linux')).toEqual([])
    expect(relocatedCredentialRoots({ GNUPGHOME: 'C:gpg' }, 'win32')).toEqual([])
    expect(relocatedCredentialRoots({ GNUPGHOME: '/a\0b' }, 'linux')).toEqual([])
  })
  it('KUBECONFIG splits on the platform delimiter; relative and empty entries are dropped', () => {
    expect(relocatedCredentialRoots({ KUBECONFIG: '/a/k1:/b/k2' }, 'linux')).toEqual(['/a/k1', '/b/k2'])
    expect(relocatedCredentialRoots({ KUBECONFIG: '/a/k1::rel:/b/k2' }, 'darwin')).toEqual(['/a/k1', '/b/k2'])
    expect(relocatedCredentialRoots({ KUBECONFIG: 'C:\\k1;D:\\k2;rel' }, 'win32')).toEqual(['C:\\k1', 'D:\\k2'])
  })
  it('XDG_CONFIG_HOME yields gh and gcloud under it', () => {
    expect(relocatedCredentialRoots({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux')).toEqual(['/x/cfg/gh', '/x/cfg/gcloud'])
    expect(relocatedCredentialRoots({ XDG_CONFIG_HOME: 'C:\\cfg' }, 'win32')).toEqual(['C:\\cfg\\gh', 'C:\\cfg\\gcloud'])
  })
  it('credentialRoots appends the relocated roots after the home roots', () => {
    const r = credentialRoots('/h', 'linux', { GNUPGHOME: '/w/gpg', KUBECONFIG: '/w/k' })
    expect(r).toContain('/h/.ssh')
    expect(r.slice(-2)).toEqual(['/w/gpg', '/w/k'])
    expect(isCredentialPath('/w/gpg/private-keys-v1.d/x', r, 'linux')).toBe(true)
    expect(isCredentialPath('/w/gpgx', r, 'linux')).toBe(false)
  })
})

describe('persistence files (spec §5.2)', () => {
  it('lists the spec files under home', () => {
    const r = persistenceRoots('/h', 'darwin')
    for (const rel of ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.profile',
      '.config/fish', '.gitconfig', '.config/git', 'Library/LaunchAgents', '.config/autostart', '.config/systemd'])
      expect(r).toContain(`/h/${rel}`)
    for (const d of ['.config/zsh', '.zsh']) for (const f of ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout']) expect(r).toContain(`/h/${d}/${f}`)
    expect(PERSISTENCE_FILES).toHaveLength(26)
    expect(persistenceRoots('C:\\Users\\u', 'win32')).toContain('C:\\Users\\u\\.config\\git')
  })
  it('env-relocated rc locations are added (ZDOTDIR, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL); relative ones ignored', () => {
    const r = persistenceRoots('/h', 'linux', { ZDOTDIR: '/w/zsh', XDG_CONFIG_HOME: '/w/cfg', GIT_CONFIG_GLOBAL: '/w/gitconfig' })
    for (const p of ['/w/zsh/.zshrc', '/w/zsh/.zshenv', '/w/zsh/.zprofile', '/w/zsh/.zlogin', '/w/zsh/.zlogout',
      '/w/cfg/fish', '/w/cfg/git', '/w/cfg/autostart', '/w/cfg/systemd', '/w/cfg/zsh/.zshrc', '/w/cfg/zsh/.zshenv', '/w/gitconfig'])
      expect(r, p).toContain(p)
    expect(persistenceRoots('/h', 'linux', { ZDOTDIR: 'zsh', XDG_CONFIG_HOME: '', GIT_CONFIG_GLOBAL: 'g' })).toEqual(persistenceRoots('/h', 'linux'))
    expect(persistenceRoots('/h', 'linux', { ZDOTDIR: '~/zd', GIT_CONFIG_GLOBAL: '~/gc' })).toEqual(expect.arrayContaining(['/h/zd/.zshrc', '/h/gc']))
    expect(persistenceRoots('C:\\Users\\u', 'win32', { Git_Config_Global: 'C:\\gc' })).toContain('C:\\gc')
  })
  it('matching folds like the credential blacklist', () => {
    const r = persistenceRoots('/h', 'darwin')
    expect(isCredentialPath('/h/.ZSHRC', r, 'darwin')).toBe(true)
    expect(isCredentialPath('/h/Library/LaunchAgents/x.plist', r, 'darwin')).toBe(true)
    expect(isCredentialPath('/h/.zshrc.bak', r, 'darwin')).toBe(false)
  })
})
