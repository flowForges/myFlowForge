import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bwrapArgs, ensureGitHooksDir, execRootFor, type BwrapParams } from './bwrap'
import { RELAY_PORT, RELAY_SOURCE } from './relay'

// 纯测试:路径都是假的,exists / realpath 注入。逐个元素断言 argv,顺序即挂载顺序(后挂的生效)

const H = '/home/u'
const CWD = `${H}/proj`
const GIT = `${CWD}/.git`
const DATA = `${H}/.mffai`
const TMP = `${DATA}/sessions/s1/tmp`
const SPILL = `${DATA}/sessions/s1/spill`
const SOCK = '/tmp/mffai-net-abc/net.sock'
const EXEC = '/opt/mff/mff'
const CMD = 'npm test && echo "ok"'

const EXISTING = new Set([
  H, CWD, GIT, `${GIT}/hooks`, `${GIT}/config`, `${GIT}/worktrees/w/gitdir`,
  DATA, TMP, SPILL, SOCK, EXEC,
  `${H}/.ssh`, '/data/ssh', `${H}/.npmrc`, `${H}/.zshrc`, `${H}/.config/fish`,
])
const REAL: Record<string, string> = { [`${H}/.ssh`]: '/data/ssh' }

function params(over: Partial<BwrapParams> = {}): BwrapParams {
  return {
    level: 'full',
    cwd: CWD,
    tmp: TMP,
    spill: SPILL,
    gitDirs: [GIT],
    gitProtected: [`${GIT}/worktrees/w/gitdir`, `${GIT}/worktrees/w/commondir`],
    hideDirs: [`${H}/.ssh`, `${H}/.aws`],
    hideFiles: [`${H}/.npmrc`, `${H}/.netrc`],
    dataDir: DATA,
    persistence: [`${H}/.zshrc`, `${H}/.bashrc`, `${H}/.config/fish`],
    unixSock: SOCK,
    execPath: EXEC,
    command: CMD,
    exists: p => EXISTING.has(p),
    realpath: p => REAL[p] ?? p,
    ...over,
  }
}

/** seq 在 args 里出现的所有起点 */
function at(args: string[], ...seq: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i + seq.length <= args.length; i++) if (seq.every((s, j) => args[i + j] === s)) out.push(i)
  return out
}
const first = (args: string[], ...seq: string[]) => { const a = at(args, ...seq); expect(a.length, seq.join(' ')).toBeGreaterThan(0); return a[0] }
const last = (args: string[], ...seq: string[]) => { const a = at(args, ...seq); expect(a.length, seq.join(' ')).toBeGreaterThan(0); return a[a.length - 1] }

/** `--` 之前的选项部分 */
const opts = (args: string[]) => args.slice(0, args.indexOf('--'))

describe('bwrapArgs', () => {
  it('full: exact argv in mount order, relay last', () => {
    expect(bwrapArgs(params())).toEqual([
      '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-net',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--bind', CWD, CWD, '--bind', GIT, GIT, '--bind', TMP, TMP, '--ro-bind', SPILL, SPILL,
      '--ro-bind', `${GIT}/hooks`, `${GIT}/hooks`, '--ro-bind', `${GIT}/config`, `${GIT}/config`,
      '--ro-bind', `${GIT}/worktrees/w/gitdir`, `${GIT}/worktrees/w/gitdir`,
      '--tmpfs', `${H}/.ssh`, '--tmpfs', '/data/ssh', '--ro-bind', '/dev/null', `${H}/.npmrc`, '--tmpfs', DATA,
      '--bind', TMP, TMP, '--ro-bind', SPILL, SPILL,
      '--ro-bind', SOCK, SOCK,
      '--setenv', 'ELECTRON_RUN_AS_NODE', '1',
      '--chdir', CWD,
      '--', EXEC, '-e', RELAY_SOURCE, String(RELAY_PORT), SOCK, '/bin/sh', '-c', CMD,
    ])
  })

  it('partial: no --unshare-net, no relay, no socket, shell sees no ELECTRON_RUN_AS_NODE', () => {
    expect(bwrapArgs(params({ level: 'partial' }))).toEqual([
      '--die-with-parent', '--unshare-user', '--unshare-pid',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--bind', CWD, CWD, '--bind', GIT, GIT, '--bind', TMP, TMP, '--ro-bind', SPILL, SPILL,
      '--ro-bind', `${GIT}/hooks`, `${GIT}/hooks`, '--ro-bind', `${GIT}/config`, `${GIT}/config`,
      '--ro-bind', `${GIT}/worktrees/w/gitdir`, `${GIT}/worktrees/w/gitdir`,
      '--tmpfs', `${H}/.ssh`, '--tmpfs', '/data/ssh', '--ro-bind', '/dev/null', `${H}/.npmrc`, '--tmpfs', DATA,
      '--bind', TMP, TMP, '--ro-bind', SPILL, SPILL,
      '--unsetenv', 'ELECTRON_RUN_AS_NODE',
      '--chdir', CWD,
      '--', '/bin/sh', '-c', CMD,
    ])
  })

  it('full without a socket (proxy down): network namespace stays, no relay', () => {
    const a = bwrapArgs(params({ unixSock: undefined }))
    expect(a.slice(0, 4)).toEqual(['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-net'])
    expect(a.slice(a.indexOf('--'))).toEqual(['--', '/bin/sh', '-c', CMD])
    expect(a).not.toContain(RELAY_SOURCE)
    expect(at(a, '--unsetenv', 'ELECTRON_RUN_AS_NODE')).toHaveLength(1)
  })

  it('--unshare-net and the relay appear only at level full', () => {
    expect(opts(bwrapArgs(params()))).toContain('--unshare-net')
    expect(bwrapArgs(params())).toContain(RELAY_SOURCE)
    expect(opts(bwrapArgs(params({ level: 'partial' })))).not.toContain('--unshare-net')
    expect(bwrapArgs(params({ level: 'partial' }))).not.toContain(RELAY_SOURCE)
  })

  it('never passes --new-session (the process-group kill depends on it)', () => {
    for (const level of ['full', 'partial'] as const) {
      for (const unixSock of [SOCK, undefined]) expect(opts(bwrapArgs(params({ level, unixSock })))).not.toContain('--new-session')
    }
  })

  it('--tmpfs <dataDir> comes before the re-binds of tmp and spill', () => {
    const a = bwrapArgs(params())
    const t = first(a, '--tmpfs', DATA)
    expect(last(a, '--bind', TMP, TMP)).toBeGreaterThan(t)
    expect(last(a, '--ro-bind', SPILL, SPILL)).toBeGreaterThan(t)
  })

  it('cwd = HOME: the cwd bind comes before the credential hides; persistence inside the writable root is ro-bound', () => {
    const a = bwrapArgs(params({ cwd: H, gitDirs: [], gitProtected: [] }))
    const b = first(a, '--bind', H, H)
    expect(first(a, '--tmpfs', `${H}/.ssh`)).toBeGreaterThan(b)
    expect(first(a, '--tmpfs', '/data/ssh')).toBeGreaterThan(b)
    expect(first(a, '--ro-bind', '/dev/null', `${H}/.npmrc`)).toBeGreaterThan(b)
    // 持久化文件:存在且在可写根内 → 只读挂回自己(只拒写,内容照读);在 tmp / spill 的盖回之后
    const z = first(a, '--ro-bind', `${H}/.zshrc`, `${H}/.zshrc`)
    expect(z).toBeGreaterThan(last(a, '--bind', TMP, TMP))
    expect(first(a, '--ro-bind', `${H}/.config/fish`, `${H}/.config/fish`)).toBeGreaterThan(b)
    expect(a).not.toContain(`${H}/.bashrc`) // 不存在
  })

  it('persistence outside every writable root gets no mount (the root is already read-only)', () => {
    const a = bwrapArgs(params())
    expect(a).not.toContain(`${H}/.zshrc`)
    expect(a).not.toContain(`${H}/.config/fish`)
  })

  it('persistence reached through a realpath spelling inside cwd is still covered', () => {
    const a = bwrapArgs(params({
      persistence: ['/link/.zshrc'],
      exists: p => EXISTING.has(p) || p === '/link/.zshrc',
      realpath: p => (p === '/link/.zshrc' ? `${CWD}/.zshrc` : REAL[p] ?? p),
    }))
    expect(at(a, '--ro-bind', '/link/.zshrc', '/link/.zshrc')).toHaveLength(1)
  })

  it('gitDir is always bound on its own (even inside cwd) and its hooks / config are ro-bound after it', () => {
    const a = bwrapArgs(params())
    const g = first(a, '--bind', GIT, GIT)
    expect(g).toBeGreaterThan(first(a, '--bind', CWD, CWD))
    expect(first(a, '--ro-bind', `${GIT}/hooks`, `${GIT}/hooks`)).toBeGreaterThan(g)
    expect(first(a, '--ro-bind', `${GIT}/config`, `${GIT}/config`)).toBeGreaterThan(g)
  })

  it('a gitDir outside cwd (worktree / subdir) is bound and protected, with the worktree .git file ro-bound', () => {
    const main = '/repos/main/.git'
    const ex = new Set([...EXISTING, main, `${main}/hooks`, `${main}/config`, `${main}/config.worktree`, `${CWD}/.git`])
    const a = bwrapArgs(params({
      gitDirs: [main],
      gitProtected: [`${CWD}/.git`],
      exists: p => ex.has(p),
    }))
    const g = first(a, '--bind', main, main)
    for (const f of ['hooks', 'config', 'config.worktree']) expect(first(a, '--ro-bind', `${main}/${f}`, `${main}/${f}`)).toBeGreaterThan(g)
    expect(first(a, '--ro-bind', `${CWD}/.git`, `${CWD}/.git`)).toBeGreaterThan(first(a, '--bind', CWD, CWD))
  })

  it('no mounts for paths that do not exist', () => {
    const a = bwrapArgs(params({
      exists: p => p === CWD || p === EXEC,
      gitDirs: [GIT, '/nope/.git'],
      gitProtected: ['/nope/x'],
    }))
    expect(opts(a)).toEqual([
      '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-net',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--bind', CWD, CWD,
      '--unsetenv', 'ELECTRON_RUN_AS_NODE',
      '--chdir', CWD,
    ])
    // 每个挂载的源 / 目标都存在(或是固定的系统路径)
    const fixed = new Set(['/', '/dev', '/proc', '/tmp', '/dev/null'])
    const full = bwrapArgs(params())
    const o = opts(full)
    for (let i = 0; i < o.length; i++) {
      if (o[i] === '--bind' || o[i] === '--ro-bind') {
        for (const p of [o[i + 1], o[i + 2]]) expect(fixed.has(p) || EXISTING.has(p), p).toBe(true)
      }
      if (o[i] === '--tmpfs') expect(fixed.has(o[i + 1]) || EXISTING.has(o[i + 1]), o[i + 1]).toBe(true)
    }
  })

  it('hide paths come in literal and realpath spellings, deduplicated', () => {
    const a = bwrapArgs(params({
      hideFiles: [`${H}/.npmrc`, '/l/.netrc'],
      exists: p => EXISTING.has(p) || p === '/l/.netrc' || p === '/r/.netrc' || p === '/r/data',
      realpath: p => ({ '/l/.netrc': '/r/.netrc', [DATA]: '/r/data' } as Record<string, string>)[p] ?? REAL[p] ?? p,
    }))
    expect(at(a, '--tmpfs', `${H}/.ssh`)).toHaveLength(1)
    expect(at(a, '--tmpfs', '/data/ssh')).toHaveLength(1)
    expect(at(a, '--ro-bind', '/dev/null', '/l/.netrc')).toHaveLength(1)
    expect(at(a, '--ro-bind', '/dev/null', '/r/.netrc')).toHaveLength(1)
    expect(at(a, '--ro-bind', '/dev/null', `${H}/.npmrc`)).toHaveLength(1)
    expect(at(a, '--tmpfs', DATA)).toHaveLength(1)
    expect(at(a, '--tmpfs', '/r/data')).toHaveLength(1)
    expect(last(a, '--bind', TMP, TMP)).toBeGreaterThan(first(a, '--tmpfs', '/r/data'))
  })

  it('the proxy socket is ro-bound by itself (never its dir), after /tmp and the hides', () => {
    const a = bwrapArgs(params())
    expect(at(a, '--ro-bind', SOCK, SOCK)).toHaveLength(1)
    expect(a).not.toContain('/tmp/mffai-net-abc')
    expect(first(a, '--ro-bind', SOCK, SOCK)).toBeGreaterThan(first(a, '--tmpfs', DATA))
  })

  it('rejects a socket whose parent is writable inside the sandbox', () => {
    for (const s of [`${CWD}/net.sock`, `${CWD}/sub/net.sock`, `${TMP}/net.sock`, `${GIT}/net.sock`]) {
      expect(() => bwrapArgs(params({ unixSock: s, exists: p => EXISTING.has(p) || p === s })), s).toThrow(/socket/)
    }
    // realpath 拼写落进可写根也拒
    expect(() => bwrapArgs(params({ unixSock: '/l/net.sock', realpath: p => (p === '/l/net.sock' ? `${TMP}/net.sock` : p) }))).toThrow(/socket/)
  })

  it('execRoot: ro-bound right after --tmpfs /tmp so an AppImage execPath stays reachable', () => {
    const exec = '/tmp/.mount_mffXYZ/mff'
    const root = '/tmp/.mount_mffXYZ'
    const a = bwrapArgs(params({ execPath: exec, execRoot: root, exists: p => EXISTING.has(p) || p === root || p === exec }))
    expect(first(a, '--ro-bind', root, root)).toBe(first(a, '--tmpfs', '/tmp') + 2)
    expect(a.slice(a.indexOf('--') + 1, a.indexOf('--') + 2)).toEqual([exec])
  })

  it('execRoot must contain execPath and sit under /tmp; an execPath under /tmp needs one when the relay runs', () => {
    expect(() => bwrapArgs(params({ execPath: '/tmp/.mount_x/mff' }))).toThrow(/execRoot/)
    expect(() => bwrapArgs(params({ execPath: '/tmp/.mount_x/mff', execRoot: '/tmp/.mount_y' }))).toThrow(/execRoot/)
    expect(() => bwrapArgs(params({ execRoot: '/opt' }))).toThrow(/execRoot/)
    // partial 不跑中转,不需要 execPath
    expect(() => bwrapArgs(params({ level: 'partial', execPath: '/tmp/.mount_x/mff' }))).not.toThrow()
  })

  it('rejects relative paths, `..` segments and control characters in every path field', () => {
    const bads = ['rel/x', `${H}/a/../b`, `${H}/a\nb`, `${H}/a\u0000b`, `${H}/a\u007fb`]
    for (const bad of bads) {
      for (const k of ['cwd', 'tmp', 'spill', 'dataDir', 'execPath', 'unixSock'] as const) {
        expect(() => bwrapArgs(params({ [k]: bad })), `${k} ${JSON.stringify(bad)}`).toThrow(/path/)
      }
      for (const k of ['gitDirs', 'gitProtected', 'hideDirs', 'hideFiles', 'persistence'] as const) {
        expect(() => bwrapArgs(params({ [k]: [bad] })), `${k} ${JSON.stringify(bad)}`).toThrow(/path/)
      }
      expect(() => bwrapArgs(params({ execPath: '/tmp/x/mff', execRoot: bad }))).toThrow(/path/)
    }
    // `..` 只按整段判
    expect(() => bwrapArgs(params({ hideDirs: [`${H}/a..b/..c`] }))).not.toThrow()
    // 控制字符只限路径;命令原样传
    expect(bwrapArgs(params({ command: 'printf "a\\n"\necho b' }))).toContain('printf "a\\n"\necho b')
  })
})

describe('execRootFor', () => {
  it('returns the first-level dir under /tmp, otherwise undefined', () => {
    expect(execRootFor('/tmp/.mount_mffXYZ/usr/bin/mff')).toBe('/tmp/.mount_mffXYZ')
    expect(execRootFor('/tmp/mff')).toBe('/tmp/mff')
    expect(execRootFor('/opt/mff/mff')).toBeUndefined()
    expect(execRootFor('/tmpx/mff')).toBeUndefined()
  })
})

describe('ensureGitHooksDir', () => {
  const R = mkdtempSync(join(tmpdir(), 'mffai-bwrap-'))
  afterAll(() => rmSync(R, { recursive: true, force: true }))

  it('creates a missing hooks dir, leaves an existing one alone, tolerates a missing gitDir', () => {
    const g = join(R, 'a', '.git')
    mkdirSync(g, { recursive: true })
    ensureGitHooksDir(g)
    expect(statSync(join(g, 'hooks')).isDirectory()).toBe(true)
    writeFileSync(join(g, 'hooks', 'keep'), 'x')
    ensureGitHooksDir(g)
    expect(existsSync(join(g, 'hooks', 'keep'))).toBe(true)
    expect(() => ensureGitHooksDir(join(R, 'missing', '.git'))).not.toThrow()
    expect(existsSync(join(R, 'missing'))).toBe(false)
  })

  it('rejects bad paths', () => {
    expect(() => ensureGitHooksDir('rel/.git')).toThrow(/path/)
    expect(() => ensureGitHooksDir(`${R}/x/../.git`)).toThrow(/path/)
  })
})
