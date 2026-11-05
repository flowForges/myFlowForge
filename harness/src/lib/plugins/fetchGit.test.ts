// 拉别人的代码(09 spec §6.3、M14):真 git,本地仓库;https 只经改写过的本机服务器或假 git,不上网。
// 环境是注入的,HOME 和全局配置都在临时目录里,不看机器上的代理
import { afterEach, describe, it, expect } from 'vitest'
import { execFileSync, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRepo } from '../../../test/pluginRig'
import { checkGitUrl, fetchGit, type FetchOpts } from './fetchGit'
import { isInternalHost } from './hosts'
import { integrityOf, walkTree } from './tree'

const PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'
const MB = 1024 * 1024
const FLAGS = [
  'protocol.allow=never',
  'protocol.https.allow=always',
  'http.followRedirects=false',
  'credential.helper=',
  'transfer.fsckObjects=true',
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.attributesFile=/dev/null',
  'core.symlinks=false',
  'core.protectHFS=true',
  'core.protectNTFS=true',
  'submodule.recurse=false',
  'gc.auto=0',
  'maintenance.auto=false',
]

const dirs: string[] = []
const pidFiles: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const f of pidFiles.splice(0)) {
    try {
      process.kill(Number(readFileSync(f, 'utf8').trim()), 'SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'mff-fetch-')))
  dirs.push(d)
  return d
}
function put(root: string, files: Record<string, string>): void {
  for (const [rel, v] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, v)
  }
}
interface Repo {
  url: string
  commit: string
  dir: string
  repo: string
  git: (...args: string[]) => string
}
/** 一个真仓库;prepare 在 commit 之前动这棵树(放符号链接之类) */
function source(files: Record<string, string>, prepare?: (root: string) => void): Repo {
  const dir = tmp()
  const tree = join(dir, 'tree')
  mkdirSync(tree)
  put(tree, files)
  prepare?.(tree)
  const { url, commit } = buildRepo(dir, tree)
  const repo = join(dir, 'repo')
  const env = { PATH, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return { url, commit, dir, repo, git }
}
function commitMore(r: Repo, files: Record<string, string>): string {
  put(r.repo, files)
  r.git('add', '-A')
  r.git('commit', '-qm', 'more')
  return r.git('rev-parse', 'HEAD')
}

type Call = { args: string[]; opts: SpawnOptions }
const subOf = (args: readonly string[]) => {
  let i = 0
  while (args[i] === '-c') i += 2
  return args[i]
}
const tailOf = (args: readonly string[]) => args.slice(args.indexOf(subOf(args)!))

/** 记录每次 spawn;rewrite 回一个子进程就用它,否则照常跑 */
function spy(rewrite?: (args: string[], o: SpawnOptions) => ReturnType<typeof nodeSpawn> | undefined) {
  const calls: Call[] = []
  const spawn = ((file: string, args: string[], opts: SpawnOptions) => {
    calls.push({ args, opts })
    return rewrite?.(args, opts) ?? nodeSpawn(file, args, opts)
  }) as unknown as typeof nodeSpawn
  return { calls, spawn, subs: () => calls.map(c => subOf(c.args)) }
}
/** 这个子命令换成一段 shell;别的照常 */
function swap(sub: string, script: string) {
  return spy((args, o) => (subOf(args) === sub ? nodeSpawn('/bin/sh', ['-c', script], o) : undefined))
}
/** 脚本:后台起个孙进程、记下它的 pid、一直等。返回脚本和 pid 文件 */
function hanger(dir: string) {
  const pidFile = join(dir, 'grandchild.pid')
  pidFiles.push(pidFile)
  return { pidFile, script: `/bin/sleep 300 & echo $! > ${pidFile}; wait` }
}
function fakeClock() {
  const pending = new Set<{ fn: () => void; ms: number }>()
  const armed: number[] = []
  return {
    pending,
    armed,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const h = { fn, ms }
        pending.add(h)
        armed.push(ms)
        return h
      },
      clearTimeout: (h: unknown) => void pending.delete(h as { fn: () => void; ms: number }),
    },
    fire(ms: number) {
      for (const h of [...pending]) {
        if (h.ms === ms) {
          pending.delete(h)
          h.fn()
        }
      }
    },
  }
}
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('never happened')
    await new Promise(r => setTimeout(r, 10))
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const groupAlive = (pgid: number) => alive(-pgid)

function target() {
  const base = tmp()
  return { base, into: join(base, 'into'), tmpHome: join(base, 'home') }
}
function run(url: string, o: Partial<FetchOpts> = {}) {
  const t = target()
  const opts: FetchOpts = { url, into: t.into, tmpHome: t.tmpHome, baseEnv: { PATH }, allowFileProtocol: true, ...o }
  return { ...t, into: opts.into, tmpHome: opts.tmpHome, promise: fetchGit(opts) }
}
async function done(url: string, o: Partial<FetchOpts> = {}) {
  const r = run(url, o)
  return { ...r, result: await r.promise }
}
const integrity = (root: string) => {
  const w = walkTree(root)
  if (!w.ok) throw new Error(w.error)
  return integrityOf(root, w.files)
}

/** PATH 上只有它的假 git:init 成功,别的打这段 stderr 退 128 */
function fakeGit(stderr: string): string {
  const bin = tmp()
  const file = join(bin, 'git')
  writeFileSync(file, `#!/bin/sh\ncase " $* " in *" init "*) exit 0;; esac\n/bin/cat >&2 <<'EOF'\n${stderr}\nEOF\nexit 128\n`)
  chmodSync(file, 0o755)
  return bin
}
const HTTPS = 'https://example.invalid/x.git'

describe('checkGitUrl', () => {
  it.each([
    'https://github.com/o/r',
    'https://github.com/o/r.git',
    'https://git.example.com:8443/a/b/c.git',
    'https://example.com',
  ])('accepts %s', url => {
    expect(checkGitUrl(url, { allowFileProtocol: false })).toEqual({ ok: true })
  })

  it.each([
    'ext::sh -c x',
    'ext::sh -c touch%20/tmp/x',
    'file:///x',
    'FILE:///x',
    'ssh://git@example.com/x',
    'git@host:x',
    'git://host/x',
    'http://host/x',
    'HTTPS://example.com/x',
    'https://user:pw@example.com/x',
    'https://user@example.com/x',
    'https://:pw@example.com/x',
    'https://token@example.com/x',
    '--upload-pack=x',
    '-oProxyCommand=x',
    ' https://example.com/x',
    'https://example.com/x ',
    'https://ho st.example.com/x',
    'https://example.com/a b',
    'https://example.com/a\nb',
    'https://example.com/a\tb',
    'https://example.com/a\x7fb',
    'https://example.com/a%0ab',
    'https://example.com/a%0Ab',
    'https://example.com/a%00b',
    'https://hos\u0442/x',
    'https://example.com/\u202ex',
    'https:///x',
    'https://',
    'https:/host/x',
    'https://-x.example.com/x',
    'https://example.com:99999/x',
    'https://evil\\@example.com/x',
    'https://example.com/x?token=abc',
    'https://example.com/x#frag',
    '/some/path',
    './x',
    '',
    `https://example.com/${'x'.repeat(2100)}`,
  ])('refuses %j', url => {
    expect(checkGitUrl(url, { allowFileProtocol: false })).toEqual({ ok: false, error: 'bad_url' })
  })

  it.each([
    '169.254.169.254',
    'git.corp',
    'git.intranet',
    'localhost.localdomain',
    '10.0.0.1',
    '8.8.8.8',
    '2852039166',
    '0xa9.0xfe.0xa9.0xfe',
    '0251.0376.0251.0376',
    '127.1',
    '0',
    'localhost',
    'LOCALHOST',
    'foo.localhost',
    'foo.local',
    'FOO.Local',
    'foo.internal',
    'a.b.internal',
    'foo.lan',
    'nas.home.arpa',
    'intranet',
    'gitlab',
  ])('refuses the internal host %s, with a port and a path too', host => {
    for (const url of [`https://${host}`, `https://${host}/o/r.git`, `https://${host}:8443/o/r.git`]) {
      expect(checkGitUrl(url, { allowFileProtocol: false }), url).toEqual({ ok: false, error: 'bad_url' })
      expect(checkGitUrl(url, { allowFileProtocol: true }), url).toEqual({ ok: false, error: 'bad_url' })
    }
  })

  it.each(['internal.example.com', 'local.example.com', 'localhost.example.com', 'mylan.example.org', 'lan.io', 'home.arpa.example.com', 'foolocal.com', '1.2.3.4.example.com', 'foo.mylocal', 'foo.notlocalhost', 'foo.notinternal', 'foo.mylan', 'foo.myhome.arpa'])('keeps the public name %s', host => {
    expect(checkGitUrl(`https://${host}/o/r.git`, { allowFileProtocol: false })).toEqual({ ok: true })
  })

  it('the option opens an absolute file:// and nothing else', () => {
    const allow = { allowFileProtocol: true }
    expect(checkGitUrl('file:///tmp/x/repo', allow)).toEqual({ ok: true })
    expect(checkGitUrl('https://example.com/x', allow)).toEqual({ ok: true })
    for (const bad of ['ext::sh -c x', 'file://host/x', 'file://x', 'file:///a b', 'file:///a\nb', 'ssh://h/x', 'git@h:x', 'http://h/x', '--upload-pack=x', 'https://u:p@example.com/x']) {
      expect(checkGitUrl(bad, allow)).toEqual({ ok: false, error: 'bad_url' })
    }
  })
})

describe('isInternalHost', () => {
  it.each(['169.254.169.254', '2852039166', '0xa9.0xfe.0xa9.0xfe', '127.1', '0', 'localhost', 'LocalHost', 'localhost.', 'foo.localhost', 'foo.local.', 'x.internal', 'x.lan', 'x.home.arpa', 'x.corp', 'a.b.intranet', 'x.private', 'nas.home', '4.3.2.1.in-addr.arpa', 'x.ip6.arpa', 'localhost.localdomain', 'host.localdomain', 'single', '[::1]', '::1', 'fe80::1', '', ' ', 'a b.com', 'a.com/x', 'u@a.com', 'a.com:80', '256.1.1.1'])('%j is internal, or not a host at all', host => {
    expect(isInternalHost(host)).toBe(true)
  })

  it.each(['github.com', 'GitHub.com', 'git.example.com', 'github.com.'])('%s is not', host => {
    expect(isInternalHost(host)).toBe(false)
  })
})

describe('fetchGit: a clean fetch', () => {
  it('lands the files with no .git, the right commit, and a stable integrity', async () => {
    const r = source({ 'a.txt': 'a', 'sub/b.txt': 'b' })
    const one = await done(r.url)
    expect(one.result).toEqual({ ok: true, commit: r.commit, warnings: [] })
    expect(readFileSync(join(one.into, 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(one.into, 'sub/b.txt'), 'utf8')).toBe('b')
    expect(existsSync(join(one.into, '.git'))).toBe(false)
    const two = await done(r.url)
    expect(integrity(two.into)).toBe(integrity(one.into))
  })

  it('leaves HOME empty', async () => {
    const r = source({ 'a.txt': 'a' })
    const { result, tmpHome } = await done(r.url)
    expect(result.ok).toBe(true)
    expect(readdirSync(tmpHome)).toEqual([])
  })

  it('works when the worker has none of the test isolation variables', async () => {
    const r = source({ 'a.txt': 'a' })
    const { result } = await done(r.url, { baseEnv: { PATH } })
    expect(result).toMatchObject({ ok: true, commit: r.commit })
  })

  it('takes a light tag, an annotated tag, a branch and a full sha', async () => {
    const r = source({ 'v.txt': 'one' })
    r.git('tag', 'light')
    r.git('tag', '-a', 'annotated', '-m', 'x')
    r.git('branch', 'side')
    const second = commitMore(r, { 'v.txt': 'two' })
    for (const ref of ['light', 'annotated', 'side', 'refs/heads/side', r.commit]) {
      const d = await done(r.url, { ref })
      expect(d.result).toMatchObject({ ok: true, commit: r.commit })
      expect(readFileSync(join(d.into, 'v.txt'), 'utf8')).toBe('one')
    }
    const head = await done(r.url)
    expect(head.result).toMatchObject({ ok: true, commit: second })
    expect(readFileSync(join(head.into, 'v.txt'), 'utf8')).toBe('two')
  })

  it('a ref that does not exist is bad_ref, a tag on a blob too, and nothing stays', async () => {
    const r = source({ 'a.txt': 'a' })
    const missing = await done(r.url, { ref: 'no-such-ref' })
    expect(missing.result).toEqual({ ok: false, error: 'bad_ref' })
    expect(existsSync(missing.into)).toBe(false)
    const blob = r.git('rev-parse', 'HEAD:a.txt')
    r.git('tag', 'on-blob', blob)
    const tagged = await done(r.url, { ref: 'on-blob' })
    expect(tagged.result).toEqual({ ok: false, error: 'bad_ref' })
    expect(existsSync(tagged.into)).toBe(false)
  })

  it('the group of every git call is reported and released, and is gone by then', async () => {
    const r = source({ 'a.txt': 'a' })
    const seen: [number, boolean][] = []
    const gone: boolean[] = []
    const { result } = await done(r.url, {
      onGroup: (pgid, ended) => {
        seen.push([pgid, ended])
        if (ended) gone.push(!groupAlive(pgid))
      },
    })
    expect(result.ok).toBe(true)
    expect(seen.length).toBe(10)
    for (let i = 0; i < seen.length; i += 2) {
      expect(seen[i]![1]).toBe(false)
      expect(seen[i + 1]).toEqual([seen[i]![0], true])
    }
    expect(gone.every(Boolean)).toBe(true)
  })

  it('when init did not work, git does not climb into a repo above into', async () => {
    const r = source({ 'a.txt': 'a', '.gitattributes': '* filter=evil\n' })
    const parent = source({ 'p.txt': 'p' })
    const marker = join(parent.dir, 'ran')
    parent.git('config', 'filter.evil.smudge', `touch ${marker}; cat`)
    const into = join(parent.repo, 'nested', 'into')
    const s = swap('init', 'exit 0')
    const d = await done(r.url, { spawn: s.spawn, into })
    expect(d.result).toEqual({ ok: false, error: 'bad_repo' })
    expect(existsSync(join(parent.repo, '.git/FETCH_HEAD'))).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(parent.git('rev-parse', 'HEAD')).toBe(parent.commit)
  })

  it('an into that already has content is refused and left alone', async () => {
    const r = source({ 'a.txt': 'a' })
    const t = target()
    put(t.into, { 'keep.txt': 'k', '.git/config': '[core]\n\thooksPath = /tmp/evil\n' })
    const s = spy()
    await expect(fetchGit({ url: r.url, into: t.into, tmpHome: t.tmpHome, baseEnv: { PATH }, allowFileProtocol: true, spawn: s.spawn })).rejects.toThrow()
    expect(s.calls).toEqual([])
    expect(readFileSync(join(t.into, 'keep.txt'), 'utf8')).toBe('k')
  })

  it('a tmpHome that cannot be made leaves no into', async () => {
    const r = source({ 'a.txt': 'a' })
    const t = target()
    writeFileSync(join(t.base, 'file'), '')
    await expect(fetchGit({ url: r.url, into: t.into, tmpHome: join(t.base, 'file', 'home'), baseEnv: { PATH }, allowFileProtocol: true })).rejects.toThrow()
    expect(existsSync(t.into)).toBe(false)
  })

  it('an into that is a link is refused', async () => {
    const r = source({ 'a.txt': 'a' })
    const t = target()
    const real = join(t.base, 'real')
    mkdirSync(real)
    symlinkSync(real, t.into)
    await expect(fetchGit({ url: r.url, into: t.into, tmpHome: t.tmpHome, baseEnv: { PATH }, allowFileProtocol: true })).rejects.toThrow()
    expect(readdirSync(real)).toEqual([])
  })
})

describe('fetchGit: every command', () => {
  it('runs in the spec order, with the whole -c list before the subcommand and -- where git takes it', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = spy()
    const { result } = await done(r.url, { spawn: s.spawn })
    expect(result.ok).toBe(true)
    expect(s.calls.map(c => tailOf(c.args))).toEqual([
      ['init', '--template='],
      ['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', r.url, 'HEAD'],
      ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
      ['ls-tree', '-r', '-z', '-l', 'FETCH_HEAD'],
      ['checkout', '--detach', 'FETCH_HEAD', '--'],
    ])
    const expected = [...FLAGS, 'protocol.file.allow=always'].flatMap(f => ['-c', f])
    for (const c of s.calls) expect(c.args.slice(0, expected.length)).toEqual(expected)
  })

  it('without the option there is no file protocol in any call', async () => {
    const s = spy()
    const { result } = await done(HTTPS, { allowFileProtocol: false, spawn: s.spawn, baseEnv: { PATH: fakeGit('fatal: nope') } })
    expect(result.ok).toBe(false)
    expect(s.subs()).toEqual(['init', 'fetch'])
    const expected = FLAGS.flatMap(f => ['-c', f])
    for (const c of s.calls) expect(c.args.slice(0, expected.length)).toEqual(expected)
    expect(s.calls.flatMap(c => c.args).join(' ')).not.toContain('protocol.file')
    expect(tailOf(s.calls[1]!.args)).toEqual(['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', HTTPS, 'HEAD'])
  })

  it('a ref is passed after --', async () => {
    const r = source({ 'a.txt': 'a' })
    r.git('tag', 'v1')
    const s = spy()
    await done(r.url, { ref: 'v1', spawn: s.spawn })
    expect(tailOf(s.calls[1]!.args).slice(-3)).toEqual(['--', r.url, 'v1'])
  })

  it('env is built from nothing: exactly the whitelist and the isolation variables', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = spy()
    const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
    const secret = 'ghp_' + 'x'.repeat(36)
    const baseEnv: NodeJS.ProcessEnv = {
      PATH,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LANGUAGE: 'zh_CN',
      HOME: '/real/home',
      USERPROFILE: '/real/home',
      GITHUB_TOKEN: secret,
      GIT_ASKPASS: '/evil',
      SSH_ASKPASS: '/evil',
      GIT_SSH_COMMAND: '/evil',
      GIT_DIR: '/evil',
      GIT_WORK_TREE: '/evil',
      GIT_CONFIG_GLOBAL: '/evil',
      GIT_CONFIG_SYSTEM: '/evil',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/evil',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=/evil'",
      GIT_ALLOW_PROTOCOL: 'ext:file:ssh',
      GIT_TEMPLATE_DIR: '/evil',
      GIT_EXEC_PATH: '/evil',
      GIT_SSL_NO_VERIFY: '1',
      XDG_CONFIG_HOME: '/evil',
      LD_PRELOAD: '/evil',
      DYLD_INSERT_LIBRARIES: '/evil',
      NODE_OPTIONS: '--evil',
      ...Object.fromEntries(proxies.map(p => [p, 'http://127.0.0.1:9'])),
    }
    const t = target()
    const { result } = await done(r.url, { spawn: s.spawn, baseEnv, into: t.into, tmpHome: t.tmpHome })
    expect(result.ok).toBe(true)
    const want = {
      PATH,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LANGUAGE: 'en',
      HOME: t.tmpHome,
      USERPROFILE: t.tmpHome,
      GIT_DIR: '.git',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_LITERAL_PATHSPECS: '1',
      ...Object.fromEntries(proxies.map(p => [p, 'http://127.0.0.1:9'])),
    }
    expect(s.calls.length).toBe(5)
    for (const c of s.calls) {
      expect(c.opts.env).toEqual(want)
      expect(c.opts.cwd).toBe(t.into)
      expect(c.opts.detached).toBe(true)
    }
    expect(JSON.stringify(s.calls.map(c => c.args))).not.toContain(secret)
  })

  it('a variable that is not set is absent, not empty', async () => {
    const s = spy()
    await done(HTTPS, { spawn: s.spawn, allowFileProtocol: false, baseEnv: { PATH: fakeGit('fatal: nope') } })
    expect(Object.keys(s.calls[0]!.opts.env!)).not.toContain('HTTP_PROXY')
    expect(Object.keys(s.calls[0]!.opts.env!)).not.toContain('LANG')
  })
})

describe('fetchGit: refused with nothing fetched', () => {
  it.each(['ext::sh -c x', 'file:///x', 'ssh://h/x', 'git@host:x', 'http://h/x', 'https://user:pw@host/x', '--upload-pack=x'])('source %s', async url => {
    const s = spy()
    const { result, into } = await done(url, { allowFileProtocol: false, spawn: s.spawn, baseEnv: { PATH: fakeGit('x') } })
    expect(result).toEqual({ ok: false, error: 'bad_url' })
    expect(s.calls).toEqual([])
    expect(existsSync(into)).toBe(false)
  })

  it.each(['--foo', '-x', '', 'a b', 'a\nb', 'a:b', 'a^b', 'a~1', 'HEAD^{tree}', '+refs/heads/x', '@{-1}', 'a..b', '../x', 'x'.repeat(201)])('ref %j', async ref => {
    const s = spy()
    const { result, into } = await done(HTTPS, { allowFileProtocol: false, ref, spawn: s.spawn, baseEnv: { PATH: fakeGit('x') } })
    expect(result).toEqual({ ok: false, error: 'bad_ref' })
    expect(s.calls).toEqual([])
    expect(existsSync(into)).toBe(false)
  })

  it.each(['..', '../x', 'a/../b', 'a/..', '/abs', '/etc/passwd', '', '.', './a', 'a//b', '.git', 'a/.git', 'a/.GIT/b', 'a\nb', 'a\\b', 'a\u202eb', 'a\u2028b', 'a\u2029b', '-x', ':(glob)x', 'x/'.repeat(40) + 'x', 'a'.repeat(1100)])('subpath %j', async subpath => {
    const s = spy()
    const { result, into } = await done(HTTPS, { allowFileProtocol: false, subpath, spawn: s.spawn, baseEnv: { PATH: fakeGit('x') } })
    expect(result).toEqual({ ok: false, error: 'bad_path' })
    expect(s.calls).toEqual([])
    expect(existsSync(into)).toBe(false)
  })
})

describe('fetchGit: config around it is not honoured', () => {
  /** 一份恶意全局配置:任何一条被读到,标记就会出现或内容就会变 */
  const evilConfig = (marker: string, other: string, url: string) =>
    [
      '[core]',
      `\thooksPath = ${dirname(marker)}/hooks`,
      `\tfsmonitor = ${dirname(marker)}/hooks/fsmonitor`,
      '[alias]',
      `\tx = !touch ${marker}`,
      '[filter "evil"]',
      `\tsmudge = touch ${marker}; cat`,
      `\tclean = touch ${marker}; cat`,
      '\trequired = true',
      '[init]',
      `\ttemplateDir = ${dirname(marker)}/template`,
      `[url "${other}"]`,
      `\tinsteadOf = ${url}`,
      '',
    ].join('\n')
  const evilScripts = (dir: string, marker: string) => {
    for (const h of ['hooks/post-checkout', 'hooks/fsmonitor', 'template/hooks/post-checkout', 'template/hooks/post-merge', 'template/hooks/reference-transaction']) {
      const p = join(dir, h)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, `#!/bin/sh\ntouch ${marker}\n`)
      chmodSync(p, 0o755)
    }
  }

  it('a global config named by the worker env, in its HOME, or in tmpHome', async () => {
    const r = source({ 'a.txt': 'real', '.gitattributes': '* filter=evil\n' })
    const other = source({ 'a.txt': 'redirected' })
    const home = tmp()
    const marker = join(home, 'ran')
    evilScripts(home, marker)
    const config = evilConfig(marker, other.url, r.url)
    writeFileSync(join(home, 'evil-config'), config)
    writeFileSync(join(home, '.gitconfig'), config)
    mkdirSync(join(home, '.config/git'), { recursive: true })
    writeFileSync(join(home, '.config/git/config'), config)
    const t = target()
    mkdirSync(t.tmpHome)
    writeFileSync(join(t.tmpHome, '.gitconfig'), config)
    mkdirSync(join(t.tmpHome, '.config/git'), { recursive: true })
    writeFileSync(join(t.tmpHome, '.config/git/config'), config)

    const d = await done(r.url, {
      into: t.into,
      tmpHome: t.tmpHome,
      baseEnv: {
        PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        GIT_CONFIG_GLOBAL: join(home, 'evil-config'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'filter.evil.smudge',
        GIT_CONFIG_VALUE_0: `touch ${marker}; cat`,
      },
    })
    expect(d.result).toMatchObject({ ok: true, commit: r.commit })
    expect(readFileSync(join(d.into, 'a.txt'), 'utf8')).toBe('real')
    expect(existsSync(marker)).toBe(false)
  })

  it('the source repo own config and hooks reach nothing', async () => {
    const r = source({ 'a.txt': 'a', '.gitattributes': '* filter=evil\n' })
    const marker = join(r.dir, 'ran')
    evilScripts(r.dir, marker)
    writeFileSync(join(r.repo, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`)
    chmodSync(join(r.repo, '.git/hooks/post-checkout'), 0o755)
    r.git('config', 'core.hooksPath', join(r.dir, 'hooks'))
    r.git('config', 'core.fsmonitor', join(r.dir, 'hooks/fsmonitor'))
    r.git('config', 'filter.evil.smudge', `touch ${marker}; cat`)
    r.git('config', 'uploadpack.packObjectsHook', join(r.dir, 'hooks/fsmonitor'))
    const d = await done(r.url)
    expect(d.result.ok).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('fetchGit: the evil fixture', () => {
  it('lands as files; every marker absent; submodule not fetched', async () => {
    const inner = source({ 'from-submodule.txt': 'x' })
    const base = tmp()
    const m = (n: string) => join(base, `ran-${n}`)
    const r = source({
      'package.json': JSON.stringify({ name: 'evil', scripts: Object.fromEntries(['preinstall', 'install', 'postinstall', 'prepare'].map(k => [k, `touch ${m(k)}`])) }),
      '.husky/pre-commit': `touch ${m('husky')}\n`,
      '.husky/post-checkout': `touch ${m('husky2')}\n`,
      Makefile: `all:\n\ttouch ${m('make')}\n`,
      '.gitmodules': `[submodule "dep"]\n\tpath = dep\n\turl = ${inner.url}\n`,
      'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${m('hook')}` }] }] } }),
      '.mcp.json': JSON.stringify({ mcpServers: { x: { command: 'sh', args: ['-c', `touch ${m('mcp')}`] } } }),
      'bin/x': `#!/bin/sh\ntouch ${m('bin')}\n`,
      'monitors/monitors.json': JSON.stringify([{ command: `touch ${m('monitor')}` }]),
      'workflows/a.js': `require('fs').writeFileSync(${JSON.stringify(m('workflow'))}, '')\n`,
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'evil', main: './main.js' }),
      'main.js': `require('fs').writeFileSync(${JSON.stringify(m('main'))}, '')\n`,
      'skills/s/SKILL.md': `---\nname: s\ndescription: d\n---\n!\`touch ${m('skill')}\`\n`,
      '.gitattributes': '* filter=evil\n',
      '.git-hooks/post-checkout': `#!/bin/sh\ntouch ${m('githooks')}\n`,
    })
    r.git('update-index', '--add', '--cacheinfo', `160000,${inner.commit},dep`)
    r.git('commit', '-qm', 'gitlink')
    const commit = r.git('rev-parse', 'HEAD')
    r.git('config', 'core.hooksPath', '.git-hooks')

    const d = await done(r.url)
    expect(d.result).toEqual({ ok: true, commit, warnings: ['submodules_skipped'] })
    for (const f of ['package.json', 'Makefile', '.husky/pre-commit', '.gitmodules', 'hooks/hooks.json', '.mcp.json', 'bin/x', 'workflows/a.js', 'main.js', 'skills/s/SKILL.md', '.gitattributes']) {
      expect(existsSync(join(d.into, f)), f).toBe(true)
    }
    expect(existsSync(join(d.into, 'dep/from-submodule.txt'))).toBe(false)
    expect(readdirSync(base)).toEqual([])
    expect(existsSync(join(d.into, '.git'))).toBe(false)
  })

  it('a .gitmodules with an update command does not pass fsck', async () => {
    const base = tmp()
    const d = await done(source({ 'a.txt': 'a', '.gitmodules': `[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x\n\tupdate = !touch ${join(base, 'ran')}\n` }).url)
    expect(d.result).toEqual({ ok: false, error: 'bad_repo' })
    expect(readdirSync(base)).toEqual([])
    expect(existsSync(d.into)).toBe(false)
  })

  it('a .gitmodules with no gitlink warns too', async () => {
    const d = await done(source({ 'a.txt': 'a', '.gitmodules': '[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x\n' }).url)
    expect(d.result).toMatchObject({ ok: true, warnings: ['submodules_skipped'] })
  })

  it('the link check is what stops a link, and if it were bypassed checkout still writes a plain file', async () => {
    const r = source({ 'a.txt': 'a' }, root => symlinkSync('/etc/hosts', join(root, 'l')))
    const s = swap('ls-tree', 'exit 0')
    const { result, into } = await done(r.url, { spawn: s.spawn })
    expect(result.ok).toBe(true)
    expect(lstatSync(join(into, 'l')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(into, 'l'), 'utf8')).toBe('/etc/hosts')
  })
})

describe('fetchGit: attributes in the tree change no bytes', () => {
  const body = 'line $Id$\nline two\n'
  it.each([
    ['ident', '*.txt ident\n'],
    ['text with crlf', '*.txt text eol=crlf\n'],
    ['legacy crlf', '*.txt crlf\n'],
    ['working-tree-encoding', '*.txt text working-tree-encoding=UTF-16\n'],
    ['all at once', '*.txt ident text eol=crlf working-tree-encoding=UTF-16 filter=evil\n'],
  ])('%s', async (_n, attrs) => {
    // 属性放在第二个 commit:blob 是原样进去的,不被作者这边的 git add 转换
    const r = source({ 'a.txt': body, 'sub/b.txt': body })
    put(r.repo, { '.gitattributes': attrs })
    r.git('add', '.gitattributes')
    r.git('commit', '-qm', 'attrs')
    const d = await done(r.url)
    expect(d.result.ok).toBe(true)
    expect(readFileSync(join(d.into, 'a.txt'), 'utf8')).toBe(body)
    expect(readFileSync(join(d.into, 'sub/b.txt'), 'utf8')).toBe(body)
    expect(readFileSync(join(d.into, '.gitattributes'), 'utf8')).toBe(attrs)
  })

  it('an attributes file inside the subtree or a nested dir counts for nothing either', async () => {
    const r = source({ 'plugin/a.txt': body, 'plugin/.gitattributes': '* ident\n', 'plugin/n/b.txt': body, 'plugin/n/.gitattributes': '* text eol=crlf\n' })
    const d = await done(r.url, { subpath: 'plugin' })
    expect(d.result.ok).toBe(true)
    expect(readFileSync(join(d.into, 'a.txt'), 'utf8')).toBe(body)
    expect(readFileSync(join(d.into, 'n/b.txt'), 'utf8')).toBe(body)
  })

  it('ident cannot blow a tree past what ls-tree counted', async () => {
    const big = '$Id$\n'.repeat(200_000)
    const r = source({ 'a.txt': big, '.gitattributes': '* ident\n' })
    const d = await done(r.url)
    expect(d.result.ok).toBe(true)
    expect(lstatSync(join(d.into, 'a.txt')).size).toBe(big.length)
  })

  it('the overriding file is written before the fetch, and leaves with .git', async () => {
    const r = source({ 'a.txt': 'a' })
    let at: string | undefined
    const s = spy((args, o) => {
      if (subOf(args) === 'fetch') at = readFileSync(join(o.cwd as string, '.git/info/attributes'), 'utf8')
      return undefined
    })
    const d = await done(r.url, { spawn: s.spawn })
    expect(at).toBe('* -text -eol -ident -filter -working-tree-encoding -crlf\n')
    expect(existsSync(join(d.into, '.git'))).toBe(false)
  })
})

describe('fetchGit: links and the tree check', () => {
  it('a symlink in the tree is refused by name, before any checkout, and into is gone', async () => {
    const r = source({ 'a/b.txt': 'x' }, root => symlinkSync('/etc/passwd', join(root, 'a/l')))
    const s = spy()
    const { result, into } = await done(r.url, { spawn: s.spawn })
    expect(result).toEqual({ ok: false, error: 'symlink', path: 'a/l' })
    expect(s.subs()).not.toContain('checkout')
    expect(existsSync(into)).toBe(false)
  })

  it('a link path with odd characters comes back clean', async () => {
    const r = source({ 'a.txt': 'a' }, root => symlinkSync('/etc/passwd', join(root, 'x\ny\u202ez\u2028w\u2029')))
    const { result } = await done(r.url)
    expect(result).toMatchObject({ ok: false, error: 'symlink' })
    if (!result.ok) expect(result.path).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
  })

  it('50 MB in the tree is refused before any checkout, with no file on disk', async () => {
    const r = source({ small: 'x' }, root => {
      for (const n of ['a', 'b', 'c']) {
        writeFileSync(join(root, n), '')
        truncateSync(join(root, n), 18 * MB)
      }
    })
    const s = spy()
    const { result, into } = await done(r.url, { spawn: s.spawn })
    expect(result).toEqual({ ok: false, error: 'too_large' })
    expect(s.subs()).not.toContain('checkout')
    expect(existsSync(into)).toBe(false)
  })

  it('a 21 MB file is refused before any checkout', async () => {
    const r = source({ small: 'x' }, root => {
      writeFileSync(join(root, 'big'), '')
      truncateSync(join(root, 'big'), 21 * MB)
    })
    const s = spy()
    const { result, into } = await done(r.url, { spawn: s.spawn })
    expect(result).toEqual({ ok: false, error: 'too_large' })
    expect(s.subs()).not.toContain('checkout')
    expect(existsSync(into)).toBe(false)
  })

  it('5000 entries pass; the 5001st kills ls-tree', async () => {
    const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, '']))
    const passes = await done(source(files(5000)).url)
    expect(passes.result.ok).toBe(true)
    const s = spy()
    const over = await done(source(files(5001)).url, { spawn: s.spawn })
    expect(over.result).toEqual({ ok: false, error: 'too_large' })
    expect(s.subs()).not.toContain('checkout')
    expect(existsSync(over.into)).toBe(false)
  })

  it('ls-tree output past the cap kills the group, grandchild included', async () => {
    const r = source({ 'a.txt': 'a' })
    const base = tmp()
    const pidFile = join(base, 'yes.pid')
    pidFiles.push(pidFile)
    const s = swap('ls-tree', `/usr/bin/yes & echo $! > ${pidFile}; wait`)
    const groups: number[] = []
    const { result, into } = await done(r.url, { spawn: s.spawn, onGroup: (p, ended) => void (ended || groups.push(p)) })
    expect(result).toEqual({ ok: false, error: 'too_large' })
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await until(() => !alive(pid))
    expect(groupAlive(groups.at(-1)!)).toBe(false)
    expect(s.subs()).not.toContain('checkout')
    expect(existsSync(into)).toBe(false)
  })

  it('a listing that is not ls-tree format is bad_repo', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = swap('ls-tree', "printf 'garbage\\000'")
    const d = await done(r.url, { spawn: s.spawn })
    expect(d.result).toEqual({ ok: false, error: 'bad_repo' })
    expect(s.subs()).not.toContain('checkout')
    expect(existsSync(d.into)).toBe(false)
  })

  it('an unexpected mode is bad_repo', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = swap('ls-tree', `printf '040000 tree ${'a'.repeat(40)}       -\\tdir\\000'`)
    expect((await done(r.url, { spawn: s.spawn })).result).toEqual({ ok: false, error: 'bad_repo' })
  })

  it('a path git would never list is bad_repo before checkout', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = swap('ls-tree', `printf '100644 blob ${'a'.repeat(40)}       1\\ta/../../x\\000'`)
    expect((await done(r.url, { spawn: s.spawn })).result).toEqual({ ok: false, error: 'bad_repo' })
    expect(s.subs()).not.toContain('checkout')
  })

  it('a malformed object is bad_repo: fsck is on', async () => {
    const r = source({ 'a.txt': 'a' })
    const empty = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: r.repo, input: '', env: { PATH, HOME: r.dir, GIT_CONFIG_GLOBAL: join(r.dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim()
    const tree = Buffer.concat([Buffer.from('40000 .git\0'), Buffer.from(empty, 'hex')])
    const bad = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], { cwd: r.repo, input: tree, env: { PATH, HOME: r.dir, GIT_CONFIG_GLOBAL: join(r.dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim()
    const commit = r.git('commit-tree', bad, '-m', 'evil')
    r.git('update-ref', 'refs/heads/main', commit)
    const d = await done(r.url)
    expect(d.result).toEqual({ ok: false, error: 'bad_repo' })
    expect(existsSync(d.into)).toBe(false)
  })
})

describe('fetchGit: subpath', () => {
  const outsideLink = (root: string) => symlinkSync('/etc/passwd', join(root, 'outlink'))

  it('the subtree becomes the root; the rest never lands', async () => {
    const r = source({ 'plugin/deep/mff.json': '{}', 'plugin/x.txt': 'x', 'outside.txt': 'o' })
    const s = spy()
    const d = await done(r.url, { subpath: 'plugin', spawn: s.spawn })
    expect(d.result).toEqual({ ok: true, commit: r.commit, warnings: [] })
    expect(readdirSync(d.into).sort()).toEqual(['deep', 'x.txt'])
    expect(readFileSync(join(d.into, 'deep/mff.json'), 'utf8')).toBe('{}')
    expect(s.calls.map(c => tailOf(c.args)).slice(-2)).toEqual([
      ['ls-tree', '-r', '-z', '-l', 'FETCH_HEAD', '--', 'plugin'],
      ['checkout', 'FETCH_HEAD', '--', 'plugin'],
    ])
  })

  it('a nested subpath, an inner dir of the same name, and a trailing slash', async () => {
    const r = source({ 'a/b/mff.json': '{}', 'a/a/x': 'x', 'z': 'z' })
    const nested = await done(r.url, { subpath: 'a/b' })
    expect(readdirSync(nested.into)).toEqual(['mff.json'])
    const same = await done(r.url, { subpath: 'a' })
    expect(readdirSync(same.into).sort()).toEqual(['a', 'b'])
    expect(readFileSync(join(same.into, 'a/x'), 'utf8')).toBe('x')
    const slash = await done(r.url, { subpath: 'a/b/' })
    expect(readdirSync(slash.into)).toEqual(['mff.json'])
  })

  it('a symlink outside the subpath does not refuse it, one inside does and is named', async () => {
    const out = source({ 'plugin/x.txt': 'x' }, outsideLink)
    expect((await done(out.url, { subpath: 'plugin' })).result.ok).toBe(true)
    const inside = source({ 'plugin/x.txt': 'x' }, root => symlinkSync('/etc/passwd', join(root, 'plugin/l')))
    const d = await done(inside.url, { subpath: 'plugin' })
    expect(d.result).toEqual({ ok: false, error: 'symlink', path: 'plugin/l' })
    expect(existsSync(d.into)).toBe(false)
  })

  it('a subpath that is itself a link is refused', async () => {
    const r = source({ 'real/x.txt': 'x' }, root => symlinkSync('real', join(root, 'alias')))
    expect((await done(r.url, { subpath: 'alias' })).result).toEqual({ ok: false, error: 'symlink', path: 'alias' })
  })

  it('a bomb outside the subpath neither counts nor lands', async () => {
    const r = source({ 'plugin/x.txt': 'x' }, root => {
      for (const n of ['a', 'b', 'c']) {
        writeFileSync(join(root, n), '')
        truncateSync(join(root, n), 21 * MB)
      }
    })
    let peak = 0
    const d = await done(r.url, { subpath: 'plugin' })
    expect(d.result.ok).toBe(true)
    for (const f of readdirSync(d.into)) peak += lstatSync(join(d.into, f)).size
    expect(peak).toBe(1)
  })

  it('a submodule outside the subpath is not warned, one inside is', async () => {
    const inner = source({ 'x': 'x' })
    const r = source({ 'plugin/x.txt': 'x', 'other/y.txt': 'y' })
    r.git('update-index', '--add', '--cacheinfo', `160000,${inner.commit},other/dep`)
    r.git('commit', '-qm', 'gitlink')
    expect((await done(r.url, { subpath: 'plugin' })).result).toMatchObject({ ok: true, warnings: [] })
    expect((await done(r.url, { subpath: 'other' })).result).toMatchObject({ ok: true, warnings: ['submodules_skipped'] })
  })

  it('integrity covers only the subtree', async () => {
    const r = source({ 'plugin/x.txt': 'x', 'outside.txt': 'one' })
    const before = integrity((await done(r.url, { subpath: 'plugin' })).into)
    commitMore(r, { 'outside.txt': 'two' })
    expect(integrity((await done(r.url, { subpath: 'plugin' })).into)).toBe(before)
    commitMore(r, { 'plugin/x.txt': 'y' })
    expect(integrity((await done(r.url, { subpath: 'plugin' })).into)).not.toBe(before)
  })

  it('a subpath that is not there, a neighbour by prefix, or a file is bad_path', async () => {
    const r = source({ 'plugin/x.txt': 'x', 'file.txt': 'f' })
    for (const subpath of ['nope', 'plug', 'file.txt', 'plugin/x.txt']) {
      const d = await done(r.url, { subpath })
      expect(d.result, subpath).toEqual({ ok: false, error: 'bad_path' })
      expect(existsSync(d.into)).toBe(false)
    }
  })
})

describe('fetchGit: size probe and timeout', () => {
  it('too_large when the probe says so after the fetch: no checkout, cleaned', async () => {
    const r = source({ 'a.txt': 'a' })
    const asked: string[] = []
    const s = spy()
    const d = await done(r.url, {
      spawn: s.spawn,
      sizeOf: dir => {
        asked.push(dir)
        return 200 * MB + 1
      },
    })
    expect(d.result).toEqual({ ok: false, error: 'too_large' })
    expect(asked[0]).toBe(d.into)
    expect(s.subs()).not.toContain('ls-tree')
    expect(s.subs()).not.toContain('checkout')
    expect(existsSync(d.into)).toBe(false)
  })

  it('exactly the limit passes', async () => {
    const r = source({ 'a.txt': 'a' })
    expect((await done(r.url, { sizeOf: () => 200 * MB })).result.ok).toBe(true)
  })

  it('a checkout that overshoots is caught too', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = spy()
    const d = await done(r.url, { spawn: s.spawn, sizeOf: () => (s.subs().includes('checkout') ? 200 * MB + 1 : 0) })
    expect(d.result).toEqual({ ok: false, error: 'too_large' })
    expect(existsSync(d.into)).toBe(false)
  })

  it('the default probe measures the disk', async () => {
    const r = source({ 'a.bin': Array.from({ length: 4096 }, (_, i) => (i * 2654435761 % 4294967296).toString(36)).join('') })
    const d = await done(r.url, { maxBytes: 1024 })
    expect(d.result).toEqual({ ok: false, error: 'too_large' })
    expect(existsSync(d.into)).toBe(false)
    expect((await done(r.url, { maxBytes: 10 * MB })).result.ok).toBe(true)
  })

  it('a remote growing past the limit on a tick kills the whole group', async () => {
    const r = source({ 'a.txt': 'a' })
    const base = tmp()
    const { pidFile, script } = hanger(base)
    const s = swap('fetch', script)
    const clock = fakeClock()
    let size = 0
    const groups: [number, boolean][] = []
    const running = run(r.url, { spawn: s.spawn, timers: clock.timers, sizeOf: () => size, onGroup: (p, e) => void groups.push([p, e]) })
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(pid)).toBe(true)
    clock.fire(1000)
    expect(alive(pid)).toBe(true)
    size = 200 * MB + 1
    clock.fire(1000)
    expect(await running.promise).toEqual({ ok: false, error: 'too_large' })
    await until(() => !alive(pid))
    expect(groups.at(-1)![1]).toBe(true)
    expect(groupAlive(groups.at(-1)![0])).toBe(false)
    expect(existsSync(running.into)).toBe(false)
    expect(clock.pending.size).toBe(0)
  })

  it('a probe that throws fails closed', async () => {
    const r = source({ 'a.txt': 'a' })
    const d = await done(r.url, {
      sizeOf: () => {
        throw new Error('boom')
      },
    })
    expect(d.result).toEqual({ ok: false, error: 'too_large' })
    expect(existsSync(d.into)).toBe(false)
  })

  it('timeout: the default is 120 s, the group is killed, into is gone', async () => {
    const r = source({ 'a.txt': 'a' })
    const base = tmp()
    const { pidFile, script } = hanger(base)
    const s = swap('fetch', script)
    const clock = fakeClock()
    const running = run(r.url, { spawn: s.spawn, timers: clock.timers })
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    clock.fire(120_000)
    expect(await running.promise).toEqual({ ok: false, error: 'timeout' })
    await until(() => !alive(pid))
    expect(existsSync(running.into)).toBe(false)
    expect(clock.pending.size).toBe(0)
  })

  it('timeoutMs replaces the default, and one budget covers every git call', async () => {
    const r = source({ 'a.txt': 'a' })
    const clock = fakeClock()
    const d = await done(r.url, { timers: clock.timers, timeoutMs: 5000 })
    expect(d.result.ok).toBe(true)
    expect(clock.armed.filter(ms => ms === 5000)).toEqual([5000])
    expect(clock.armed).not.toContain(120_000)
    expect(clock.pending.size).toBe(0)
  })

  it('a timeout between two calls stops the next one', async () => {
    const r = source({ 'a.txt': 'a' })
    const clock = fakeClock()
    let fired = false
    const s = spy()
    const d = await done(r.url, {
      spawn: s.spawn,
      timers: clock.timers,
      onGroup: (_p, ended) => {
        if (ended && !fired && s.subs().at(-1) === 'init') {
          fired = true
          clock.fire(120_000)
        }
      },
    })
    expect(d.result).toEqual({ ok: false, error: 'timeout' })
    expect(s.subs()).toEqual(['init'])
  })

  it('a descendant left in the group after git exits is killed with it', async () => {
    const r = source({ 'a.txt': 'a' })
    const base = tmp()
    const pidFile = join(base, 'straggler.pid')
    pidFiles.push(pidFile)
    const s = swap('rev-parse', `/bin/sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}; echo ${r.commit}`)
    const d = await done(r.url, { spawn: s.spawn })
    expect(d.result.ok).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await until(() => !alive(pid))
  })

  it('a descendant that left the group and holds the pipe does not hang it', async () => {
    const r = source({ 'a.txt': 'a' })
    const base = tmp()
    const pidFile = join(base, 'escaped.pid')
    pidFiles.push(pidFile)
    const script = `/usr/bin/perl -e 'use POSIX; POSIX::setsid(); sleep 300' & echo $! > ${pidFile}; exit 0`
    const s = swap('init', script)
    const d = await done(r.url, { spawn: s.spawn })
    expect(d.result).toEqual({ ok: false, error: 'bad_repo' })
  })
})

describe('fetchGit: codes and stderr', () => {
  it.each([
    ['fatal: could not read Username for \'https://x\': terminal prompts disabled', 'auth_required'],
    ['fatal: could not read Password for \'https://x\': terminal prompts disabled', 'auth_required'],
    ['remote: x\nfatal: Authentication failed for \'https://x/\'', 'auth_required'],
    ['fatal: unable to access \'https://x/\': The requested URL returned error: 403', 'auth_required'],
    ['fatal: unable to access \'https://x/\': The requested URL returned error: 401', 'auth_required'],
    ['fatal: unable to access \'https://x/\': The requested URL returned error: 301', 'network'],
    ['fatal: unable to access \'https://x/\': The requested URL returned error: 404', 'network'],
    ['fatal: repository \'https://x/\' not found', 'network'],
    ['fatal: unable to access \'https://x/\': Could not resolve host: x', 'network'],
    ['fatal: unable to access \'https://x/\': SSL certificate problem', 'network'],
    ['something nobody has seen', 'network'],
    ['fatal: couldn\'t find remote ref nope', 'bad_ref'],
    ['fatal: Remote branch nope not found in upstream origin', 'bad_ref'],
    ['fatal: remote error: upload-pack: not our ref aaaa', 'bad_ref'],
    ['error: Server does not allow request for unadvertised object aaaa', 'bad_ref'],
    ['error: object aaaa: hasDotgit: contains \'.git\'\nfatal: fsck error in packed object', 'bad_repo'],
    ['fatal: index-pack failed', 'bad_repo'],
    ['fatal: unpack-objects failed', 'bad_repo'],
    ['fatal: bad object aaaa', 'bad_repo'],
    ['fatal: \'x\' does not appear to be a git repository', 'bad_repo'],
    ['fatal: https://x/info/refs not valid: is this a git repository?', 'bad_repo'],
  ])('%s → %s', async (stderr, want) => {
    const { result, into } = await done(HTTPS, { allowFileProtocol: false, baseEnv: { PATH: fakeGit(stderr) } })
    expect(result).toEqual({ ok: false, error: want })
    expect(existsSync(into)).toBe(false)
  })

  it('what the remote prints cannot pick the code', async () => {
    const stderr = 'remote: fatal: Authentication failed\nremote: could not read Username\nremote: couldn\'t find remote ref x\nremote: fsck error\nfatal: the remote end hung up unexpectedly'
    const { result } = await done(HTTPS, { allowFileProtocol: false, baseEnv: { PATH: fakeGit(stderr) } })
    expect(result).toEqual({ ok: false, error: 'network' })
  })

  it.each([
    'fatal: remote error: Authentication failed',
    "fatal: remote error: couldn't find remote ref x",
    'fatal: remote error: object is corrupt',
    'fatal: remote error: x\nAuthentication failed',
    'fatal: remote error: x\ncould not read Username',
    "fatal: remote error: x\ncouldn't find remote ref y",
    'fatal: remote error: x\nfsck error',
    'fatal: remote error: x\nnot our ref y',
  ])('an ERR from the remote cannot pick the code: %j', async stderr => {
    expect((await done(HTTPS, { allowFileProtocol: false, baseEnv: { PATH: fakeGit(stderr) } })).result).toEqual({ ok: false, error: 'network' })
  })

  it.each([
    ['https://example.com/fsck-helpers.git', "fatal: unable to access 'https://example.com/fsck-helpers.git/': Failed to connect to example.com port 443: Connection refused"],
    ['https://example.com/index-pack.git', "fatal: unable to access 'https://example.com/index-pack.git/info/refs': Connection refused"],
    ['https://example.com/corrupt/not-our-ref.git', "fatal: unable to access 'https://example.com/corrupt/not-our-ref.git/': Connection refused"],
    ['https://EXAMPLE.com/malformed.git', "fatal: unable to access 'https://example.com/malformed.git/': Connection refused"],
    ['https://fsck.example.com/x.git', 'fatal: unable to access: Could not resolve host: fsck.example.com'],
    ['https://corrupt.example.com/x.git', 'fatal: unable to access: Failed to connect to corrupt.example.com port 443'],
    ['https://FSCK.example.com/x.git', 'fatal: unable to access: Could not resolve host: fsck.example.com'],
  ])('the address cannot pick the code: %s', async (url, stderr) => {
    expect((await done(url, { allowFileProtocol: false, baseEnv: { PATH: fakeGit(stderr) } })).result).toEqual({ ok: false, error: 'network' })
  })

  it('the real words still count once the address is out of them', async () => {
    const url = 'https://example.com/fsck.git'
    const stderr = `fatal: Authentication failed for '${url}/'`
    expect((await done(url, { allowFileProtocol: false, baseEnv: { PATH: fakeGit(stderr) } })).result).toEqual({ ok: false, error: 'auth_required' })
  })

  it('stderr holding a URL with a token reaches nothing', async () => {
    const token = 'ghp_' + 'y'.repeat(36)
    const stderr = `fatal: unable to access 'https://user:${token}@host/x/': proxy http://acct:${token}@proxy:8080 refused`
    const groups: unknown[] = []
    const { result } = await done(HTTPS, { allowFileProtocol: false, baseEnv: { PATH: fakeGit(stderr) }, onGroup: (...a) => void groups.push(a) })
    expect(result).toEqual({ ok: false, error: 'network' })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(groups)).not.toContain(token)
  })

  it('git missing from PATH is git_not_found', async () => {
    const { result, into } = await done(HTTPS, { allowFileProtocol: false, baseEnv: { PATH: join(tmp(), 'nope') } })
    expect(result).toEqual({ ok: false, error: 'git_not_found' })
    expect(existsSync(into)).toBe(false)
  })

  it('the macOS shim with no developer tools is git_not_found', async () => {
    const bin = tmp()
    writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "xcode-select: note: No developer tools were found, requesting install." >&2\nexit 1\n')
    chmodSync(join(bin, 'git'), 0o755)
    expect((await done(HTTPS, { allowFileProtocol: false, baseEnv: { PATH: bin } })).result).toEqual({ ok: false, error: 'git_not_found' })
  })

  it('an init that fails stops there', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = swap('init', 'exit 1')
    const d = await done(r.url, { spawn: s.spawn })
    expect(d.result).toEqual({ ok: false, error: 'bad_repo' })
    expect(s.subs()).toEqual(['init'])
    expect(existsSync(d.into)).toBe(false)
  })

  it('a rev-parse that does not give a sha is bad_repo', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = swap('rev-parse', 'echo not-a-sha')
    expect((await done(r.url, { spawn: s.spawn })).result).toEqual({ ok: false, error: 'bad_repo' })
    expect(s.subs()).not.toContain('checkout')
  })

  it('a checkout that fails is bad_repo and cleans up', async () => {
    const r = source({ 'a.txt': 'a' })
    const s = swap('checkout', 'exit 1')
    const d = await done(r.url, { spawn: s.spawn })
    expect(d.result).toEqual({ ok: false, error: 'bad_repo' })
    expect(existsSync(d.into)).toBe(false)
  })
})

describe('fetchGit: a real HTTP remote on loopback, real git', () => {
  /** 真 git 带着 fetchGit 给的那串 -c 和环境;只把地址换成本机服务器,再放开 http。https 证书是这里造不出来的东西 */
  function listen(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler)
    servers.push(server)
    return new Promise<{ port: number; spawn: typeof nodeSpawn }>(res => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        const spawn = ((file: string, args: string[], o: SpawnOptions) =>
          nodeSpawn(file, ['-c', 'protocol.http.allow=always', ...args.map(a => (a === HTTPS ? `http://127.0.0.1:${port}/x.git` : a))], o)) as unknown as typeof nodeSpawn
        res({ port, spawn })
      })
    })
  }

  it('a 301 is not followed, and the code is network', async () => {
    const hits: string[] = []
    let moved = ''
    const { port, spawn } = await listen((req, res) => {
      hits.push(req.url ?? '')
      if (req.url?.startsWith('/x.git')) {
        res.writeHead(301, { Location: moved })
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('internal')
      }
    })
    moved = `http://127.0.0.1:${port}/internal/info/refs?service=git-upload-pack`
    const d = await done(HTTPS, { allowFileProtocol: false, spawn })
    expect(d.result).toEqual({ ok: false, error: 'network' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.filter(h => h.startsWith('/internal'))).toEqual([])
    expect(existsSync(d.into)).toBe(false)
  })

  it('a 401 is auth_required, without a prompt', async () => {
    const { spawn } = await listen((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' })
      res.end()
    })
    expect((await done(HTTPS, { allowFileProtocol: false, spawn })).result).toEqual({ ok: false, error: 'auth_required' })
  })

  it.each([
    ['Authentication failed'],
    ["couldn't find remote ref x"],
    ['object is corrupt'],
    ['x\nAuthentication failed'],
  ])('a real ERR packet from the server is network: %j', async text => {
    const { spawn } = await listen((_req, res) => {
      const line = `ERR ${text}`
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' })
      res.end((line.length + 4).toString(16).padStart(4, '0') + line)
    })
    expect((await done(HTTPS, { allowFileProtocol: false, spawn })).result).toEqual({ ok: false, error: 'network' })
  })

  it('a 404 is network', async () => {
    const { spawn } = await listen((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    expect((await done(HTTPS, { allowFileProtocol: false, spawn })).result).toEqual({ ok: false, error: 'network' })
  })
})
