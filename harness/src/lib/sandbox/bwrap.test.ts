import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bwrapArgs, ensureGitHooksDir, execRootFor, type BwrapParams } from './bwrap'
import { RELAY_PORT, RELAY_SOURCE } from './relay'

// 纯测试:路径都是假的,exists / realpath / isDir / isSymlink 注入。逐个元素断言 argv,顺序即挂载顺序(后挂的生效)

const H = '/home/u'
const CWD = `${H}/proj`
const GIT = `${CWD}/.git`
const DATA = `${H}/.mffai`
const TMP = `${DATA}/sessions/s1/tmp`
const SPILL = `${DATA}/sessions/s1/spill`
const SOCK = '/tmp/mffai-net-abc/net.sock'
const EXEC = '/opt/mff/mff'
const CMD = 'npm test && echo "ok"'
const RUN = '/run/user/1000'

const DIRS = new Set([H, CWD, GIT, `${GIT}/hooks`, DATA, TMP, SPILL, '/data/ssh', `${H}/.config`, `${H}/.config/fish`, RUN])
const FILES = new Set([`${GIT}/config`, `${GIT}/worktrees/w/gitdir`, SOCK, EXEC, `${H}/.npmrc`, `${H}/.zshrc`])
const EXISTING = new Set([...DIRS, ...FILES])
const REAL: Record<string, string> = { [`${H}/.ssh`]: '/data/ssh' }
const LINKS = new Set([`${H}/.ssh`])

const UNSET = [
  '--unsetenv', 'SSH_AUTH_SOCK', '--unsetenv', 'DBUS_SESSION_BUS_ADDRESS', '--unsetenv', 'GPG_AGENT_INFO', '--unsetenv', 'DOCKER_HOST',
  '--unsetenv', 'CONTAINER_HOST', '--unsetenv', 'TMUX', '--unsetenv', 'STY',
]

function fs(extraDirs: string[] = [], extraFiles: string[] = [], real: Record<string, string> = {}, links: string[] = []) {
  const dirs = new Set([...DIRS, ...extraDirs])
  const all = new Set([...EXISTING, ...extraDirs, ...extraFiles])
  return {
    exists: (p: string) => all.has(p),
    isDir: (p: string) => dirs.has(p),
    realpath: (p: string) => real[p] ?? REAL[p] ?? p,
    isSymlink: (p: string) => links.includes(p) || LINKS.has(p),
  }
}

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
    env: { HOME: H },
    uid: 1000,
    ...fs(),
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
      '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-net',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--bind', CWD, CWD, '--bind', GIT, GIT, '--bind', TMP, TMP, '--ro-bind', SPILL, SPILL,
      '--ro-bind', `${GIT}/hooks`, `${GIT}/hooks`, '--ro-bind', `${GIT}/config`, `${GIT}/config`,
      '--ro-bind', `${GIT}/worktrees/w/gitdir`, `${GIT}/worktrees/w/gitdir`,
      '--tmpfs', RUN, '--tmpfs', '/data/ssh', '--ro-bind', '/dev/null', `${H}/.npmrc`, '--tmpfs', DATA,
      '--bind', TMP, TMP, '--ro-bind', SPILL, SPILL,
      '--ro-bind', SOCK, SOCK,
      ...UNSET,
      '--setenv', 'ELECTRON_RUN_AS_NODE', '1',
      '--chdir', CWD,
      '--', EXEC, '-e', RELAY_SOURCE, String(RELAY_PORT), SOCK, '/bin/sh', '-c', CMD,
    ])
  })

  it('partial: no --unshare-net, no relay, no socket, shell sees no ELECTRON_RUN_AS_NODE', () => {
    expect(bwrapArgs(params({ level: 'partial' }))).toEqual([
      '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--bind', CWD, CWD, '--bind', GIT, GIT, '--bind', TMP, TMP, '--ro-bind', SPILL, SPILL,
      '--ro-bind', `${GIT}/hooks`, `${GIT}/hooks`, '--ro-bind', `${GIT}/config`, `${GIT}/config`,
      '--ro-bind', `${GIT}/worktrees/w/gitdir`, `${GIT}/worktrees/w/gitdir`,
      '--tmpfs', RUN, '--tmpfs', '/data/ssh', '--ro-bind', '/dev/null', `${H}/.npmrc`, '--tmpfs', DATA,
      '--bind', TMP, TMP, '--ro-bind', SPILL, SPILL,
      ...UNSET,
      '--unsetenv', 'ELECTRON_RUN_AS_NODE',
      '--chdir', CWD,
      '--', '/bin/sh', '-c', CMD,
    ])
  })

  it('full without a socket (proxy down): network namespace stays, no relay', () => {
    const a = bwrapArgs(params({ unixSock: undefined }))
    expect(a.slice(0, 5)).toEqual(['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-net'])
    expect(a.slice(a.indexOf('--'))).toEqual(['--', '/bin/sh', '-c', CMD])
    expect(a).not.toContain(RELAY_SOURCE)
    expect(at(a, '--unsetenv', 'ELECTRON_RUN_AS_NODE')).toHaveLength(1)
  })

  it('--unshare-net and the relay appear only at level full; --unshare-ipc at both', () => {
    expect(opts(bwrapArgs(params()))).toContain('--unshare-net')
    expect(bwrapArgs(params())).toContain(RELAY_SOURCE)
    expect(opts(bwrapArgs(params({ level: 'partial' })))).not.toContain('--unshare-net')
    expect(bwrapArgs(params({ level: 'partial' }))).not.toContain(RELAY_SOURCE)
    for (const level of ['full', 'partial'] as const) expect(opts(bwrapArgs(params({ level })))).toContain('--unshare-ipc')
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

  it('cwd = HOME: the cwd bind comes before the hides; persistence is ro-bound before the hides', () => {
    const a = bwrapArgs(params({ cwd: H, gitDirs: [], gitProtected: [] }))
    const b = first(a, '--bind', H, H)
    const ssh = first(a, '--tmpfs', '/data/ssh')
    expect(ssh).toBeGreaterThan(b)
    expect(first(a, '--ro-bind', '/dev/null', `${H}/.npmrc`)).toBeGreaterThan(b)
    // 持久化文件:存在且在可写根内 → 只读挂回自己(只拒写,内容照读);在隐藏之前(源是宿主,挂在后面会读回被隐藏的内容)
    const z = first(a, '--ro-bind', `${H}/.zshrc`, `${H}/.zshrc`)
    expect(z).toBeGreaterThan(b)
    expect(z).toBeLessThan(first(a, '--tmpfs', RUN))
    expect(first(a, '--ro-bind', `${H}/.config/fish`, `${H}/.config/fish`)).toBeLessThan(ssh)
    expect(a).not.toContain(`${H}/.bashrc`) // 不存在
  })

  it('persistence outside every writable root gets no mount (the root is already read-only)', () => {
    const a = bwrapArgs(params())
    expect(a).not.toContain(`${H}/.zshrc`)
    expect(a).not.toContain(`${H}/.config/fish`)
  })

  it('persistence whose realpath is inside cwd is ro-bound at the realpath only', () => {
    const a = bwrapArgs(params({ persistence: ['/link/.zshrc'], ...fs([], [`${CWD}/.zshrc`, '/link/.zshrc'], { '/link/.zshrc': `${CWD}/.zshrc` }) }))
    expect(at(a, '--ro-bind', `${CWD}/.zshrc`, `${CWD}/.zshrc`)).toHaveLength(1)
    expect(a).not.toContain('/link/.zshrc')
  })

  it('symlinked persistence inside a writable root: the link dir is ro-bound when it is not itself a writable root', () => {
    // cwd = HOME;~/.config/fish → ~/dotfiles/fish(链接在 ~/.config 里 → 只读挂 ~/.config);
    // ~/.zshrc → ~/dotfiles/.zshrc(链接就在 HOME = cwd 里,挂不了 HOME → 只剩目标那一条)
    const f = fs([`${H}/dotfiles`, `${H}/dotfiles/fish`], [`${H}/dotfiles/.zshrc`], {
      [`${H}/.zshrc`]: `${H}/dotfiles/.zshrc`, [`${H}/.config/fish`]: `${H}/dotfiles/fish`,
    }, [`${H}/.zshrc`, `${H}/.config/fish`])
    const a = bwrapArgs(params({ cwd: H, gitDirs: [], gitProtected: [], ...f }))
    expect(at(a, '--ro-bind', `${H}/.config`, `${H}/.config`)).toHaveLength(1)
    expect(at(a, '--ro-bind', `${H}/dotfiles/fish`, `${H}/dotfiles/fish`)).toHaveLength(1)
    expect(at(a, '--ro-bind', `${H}/dotfiles/.zshrc`, `${H}/dotfiles/.zshrc`)).toHaveLength(1)
    expect(at(a, '--ro-bind', H, H)).toHaveLength(0)
    expect(a).not.toContain(`${H}/.zshrc`)
    expect(first(a, '--ro-bind', `${H}/.config`, `${H}/.config`)).toBeLessThan(first(a, '--tmpfs', '/data/ssh'))
  })

  it('gitDir is always bound on its own (even inside cwd) and its hooks / config are ro-bound after it', () => {
    const a = bwrapArgs(params())
    const g = first(a, '--bind', GIT, GIT)
    expect(g).toBeGreaterThan(first(a, '--bind', CWD, CWD))
    expect(first(a, '--ro-bind', `${GIT}/hooks`, `${GIT}/hooks`)).toBeGreaterThan(g)
    expect(first(a, '--ro-bind', `${GIT}/config`, `${GIT}/config`)).toBeGreaterThan(g)
  })

  it('an existing gitDir without hooks fails closed (call ensureGitHooksDir first)', () => {
    const g = '/repos/nohooks/.git'
    expect(() => bwrapArgs(params({ gitDirs: [g], ...fs([g]) }))).toThrow(/hooks/)
  })

  it('a symlinked (even dangling) .git/hooks, config or config.worktree fails closed with a clear error', () => {
    for (const f of ['hooks', 'config', 'config.worktree']) {
      const link = `${GIT}/${f}`
      // 相对链接(目标存在)
      expect(() => bwrapArgs(params({ ...fs([], [], {}, [link]) })), f).toThrow(/is a symlink/)
      // 悬空链接:exists 跟随链接为假,仍按符号链接报错,而不是"缺 hooks"
      const ex = new Set([...EXISTING].filter(p => p !== link))
      expect(() => bwrapArgs(params({ ...fs([], [], {}, [link]), exists: p => ex.has(p) })), `${f} dangling`).toThrow(/is a symlink/)
    }
  })

  it('a gitDir outside cwd (worktree / subdir) is bound and protected, with the worktree .git file ro-bound', () => {
    const main = '/repos/main/.git'
    const a = bwrapArgs(params({
      gitDirs: [main],
      gitProtected: [`${CWD}/.git`],
      ...fs([main, `${main}/hooks`], [`${main}/config`, `${main}/config.worktree`, `${CWD}/.git`]),
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
      '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-net',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--bind', CWD, CWD,
      ...UNSET,
      '--unsetenv', 'ELECTRON_RUN_AS_NODE',
      '--chdir', CWD,
    ])
    // 每个挂载的源 / 目标都存在(或是固定的系统路径)
    const fixed = new Set(['/', '/dev', '/proc', '/tmp', '/dev/null'])
    const o = opts(bwrapArgs(params()))
    for (let i = 0; i < o.length; i++) {
      if (o[i] === '--bind' || o[i] === '--ro-bind') {
        for (const p of [o[i + 1], o[i + 2]]) expect(fixed.has(p) || EXISTING.has(p), p).toBe(true)
      }
      if (o[i] === '--tmpfs') expect(fixed.has(o[i + 1]) || EXISTING.has(o[i + 1]), o[i + 1]).toBe(true)
    }
  })

  it('mounts only realpaths: a symlinked hide or data dir is mounted at its target, never at the link', () => {
    const a = bwrapArgs(params({
      hideFiles: [`${H}/.npmrc`, '/l/.netrc'],
      ...fs(['/r/data'], ['/l/.netrc', '/r/.netrc'], { '/l/.netrc': '/r/.netrc', [DATA]: '/r/data' }),
    }))
    expect(at(a, '--tmpfs', '/data/ssh')).toHaveLength(1)
    expect(a).not.toContain(`${H}/.ssh`)
    expect(at(a, '--ro-bind', '/dev/null', '/r/.netrc')).toHaveLength(1)
    expect(a).not.toContain('/l/.netrc')
    expect(at(a, '--tmpfs', '/r/data')).toHaveLength(1)
    expect(at(a, '--tmpfs', DATA)).toHaveLength(0)
    expect(last(a, '--bind', TMP, TMP)).toBeGreaterThan(first(a, '--tmpfs', '/r/data'))
  })

  it('writable roots and --chdir use the realpath (HOME behind a symlinked /home)', () => {
    const real = (p: string) => p.startsWith('/home/') ? `/var${p}` : p
    const ex = new Set([...EXISTING].map(real))
    const a = bwrapArgs(params({ exists: p => ex.has(p), isDir: p => DIRS.has(p.replace(/^\/var/, '')), realpath: real, isSymlink: () => false }))
    expect(at(a, '--bind', `/var${CWD}`, `/var${CWD}`)).toHaveLength(1)
    expect(at(a, '--tmpfs', `/var${DATA}`)).toHaveLength(1)
    expect(a[a.indexOf('--chdir') + 1]).toBe(`/var${CWD}`)
    expect(opts(a).some(x => x.startsWith('/home/'))).toBe(false)
  })

  it('hides pick --tmpfs or /dev/null by the real type, whichever list the path came in', () => {
    const a = bwrapArgs(params({ hideDirs: [`${H}/.npmrc`], hideFiles: [`${H}/.ssh`] }))
    expect(at(a, '--ro-bind', '/dev/null', `${H}/.npmrc`)).toHaveLength(1)
    expect(at(a, '--tmpfs', '/data/ssh')).toHaveLength(1)
  })

  it('hides the runtime dir, the env-named sockets and the well-known sockets; strips their env vars', () => {
    const agent = `${H}/.agent.sock`
    const a = bwrapArgs(params({
      env: {
        HOME: H,
        XDG_RUNTIME_DIR: '/xdg',
        SSH_AUTH_SOCK: agent,
        GPG_AGENT_INFO: '/g/S.gpg-agent:123:1',
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${RUN}/bus,guid=abc;unix:path=/b/bus%20x;unix:abstract=/z`,
        DOCKER_HOST: `unix://${H}/.rd/docker.sock`,
        CONTAINER_HOST: 'unix:///c/podman.sock',
        TMUX: `${H}/.tmux-sock/default,1234,0`,
      },
      ...fs(['/xdg', '/run/podman', '/run/screen'], [agent, '/g/S.gpg-agent', '/b/bus x', `${RUN}/bus`, '/var/run/docker.sock', '/run/dbus/system_bus_socket',
        `${H}/.rd/docker.sock`, '/c/podman.sock', `${H}/.tmux-sock/default`]),
    }))
    expect(at(a, '--tmpfs', '/run/screen')).toHaveLength(1)
    for (const f of [`${H}/.rd/docker.sock`, '/c/podman.sock', `${H}/.tmux-sock/default`]) expect(at(a, '--ro-bind', '/dev/null', f), f).toHaveLength(1)
    // tcp:// 的 DOCKER_HOST 不是路径
    expect(() => bwrapArgs(params({ env: { HOME: H, DOCKER_HOST: 'tcp://127.0.0.1:2375' } }))).not.toThrow()
    expect(at(a, '--tmpfs', RUN)).toHaveLength(1)
    expect(at(a, '--tmpfs', '/xdg')).toHaveLength(1)
    for (const f of [agent, '/g/S.gpg-agent', '/b/bus x', '/var/run/docker.sock', '/run/dbus/system_bus_socket']) {
      expect(at(a, '--ro-bind', '/dev/null', f), f).toHaveLength(1)
    }
    expect(a).not.toContain(`${RUN}/bus`) // 已在被隐藏的运行时目录里
    expect(a).not.toContain('/run/docker.sock') // 不存在
    for (const level of ['full', 'partial'] as const) {
      const o = opts(bwrapArgs(params({ level })))
      for (const k of ['SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'GPG_AGENT_INFO', 'DOCKER_HOST', 'CONTAINER_HOST', 'TMUX', 'STY']) expect(at(o, '--unsetenv', k)).toHaveLength(1)
    }
  })

  it('malformed env socket values are skipped, not thrown', () => {
    expect(() => bwrapArgs(params({ env: { HOME: H, SSH_AUTH_SOCK: 'rel/sock', GPG_AGENT_INFO: '/a\nb:1:1', XDG_RUNTIME_DIR: '' } }))).not.toThrow()
  })

  it('the proxy socket is ro-bound by itself (never its dir), after /tmp and the hides', () => {
    const a = bwrapArgs(params())
    expect(at(a, '--ro-bind', SOCK, SOCK)).toHaveLength(1)
    expect(a).not.toContain('/tmp/mffai-net-abc')
    expect(first(a, '--ro-bind', SOCK, SOCK)).toBeGreaterThan(first(a, '--tmpfs', DATA))
  })

  it('rejects a socket whose parent is writable inside the sandbox', () => {
    for (const s of [`${CWD}/net.sock`, `${CWD}/sub/net.sock`, `${TMP}/net.sock`, `${GIT}/net.sock`]) {
      expect(() => bwrapArgs(params({ unixSock: s, ...fs([], [s]) })), s).toThrow(/socket/)
    }
    // realpath 落进可写根也拒
    expect(() => bwrapArgs(params({ unixSock: '/l/net.sock', realpath: p => (p === '/l/net.sock' ? `${TMP}/net.sock` : p) }))).toThrow(/socket/)
  })

  it('rejects / or an ancestor of HOME as a writable root', () => {
    expect(() => bwrapArgs(params({ cwd: '/' }))).toThrow(/too broad/)
    expect(() => bwrapArgs(params({ cwd: '/home' }))).toThrow(/too broad/)
    expect(() => bwrapArgs(params({ gitDirs: ['/'] }))).toThrow(/too broad/)
    expect(() => bwrapArgs(params({ cwd: H, gitDirs: [] }))).not.toThrow()
  })

  it('execRoot: ro-bound right after --tmpfs /tmp so an AppImage execPath stays reachable', () => {
    const exec = '/tmp/.mount_mffXYZ/mff'
    const root = '/tmp/.mount_mffXYZ'
    const a = bwrapArgs(params({ execPath: exec, execRoot: root, ...fs([root], [exec]) }))
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
