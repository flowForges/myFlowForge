import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { credentialRoots, isCredentialPath, isInside, resolveToolPath } from './paths'

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
})
