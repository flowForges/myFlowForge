import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as git_ from './snapshot'
import { createGit, gitEnv, NO_REPO, parsePin, pinIntact, pinRepo, unsafeFilterCommand, type Git, type PinnedRepo, type SnapshotOpts, type GitReadOpts } from './snapshot'

// 这个文件大部分测的不是钉子:每次调用现定一个。钉子自己的语义在 "the pinned repo" 里
type Later<T> = Omit<T, 'pin'>
const takeSnapshot = async (cwd: string, ref: string, g: Git, o: Later<SnapshotOpts> = {}) => git_.takeSnapshot(cwd, ref, g, { ...o, pin: await pinRepo(cwd, g) })
const changes = async (cwd: string, from: string, to: string, g: Git, o: Later<GitReadOpts> = {}) => git_.changes(cwd, from, to, g, { ...o, pin: await pinRepo(cwd, g) })
const restore = async (cwd: string, from: string, files: Parameters<typeof git_.restore>[2], g: Git, o: Later<GitReadOpts> = {}) => git_.restore(cwd, from, files, g, { ...o, pin: await pinRepo(cwd, g) })
const pruneRefs = async (cwd: string, prefix: string, keep: number, g: Git, o: { tmpDir?: string } = {}) => git_.pruneRefs(prefix, keep, g, { ...o, pin: await pinRepo(cwd, g) })
const refExists = async (cwd: string, ref: string, g: Git, o: { tmpDir?: string } = {}) => git_.refExists(ref, g, { ...o, pin: await pinRepo(cwd, g) })

let root: string
let home: string
let repo: string
let tmp: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-snap-test-')))
  home = join(root, 'home')
  repo = join(root, 'repo')
  tmp = join(root, 'tmp')
  for (const d of [home, repo, tmp]) mkdirSync(d)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 家目录、全局配置都在临时目录,不读系统配置;不带任何继承的 GIT_* */
const injected = () => ({ GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
const base = () => ({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home })
const userEnv = () => ({ ...base(), ...injected() })
const git = (): Git => createGit({ base: base(), extraEnv: injected() })

/** 用户自己的 git 操作(准备夹具、比对状态);提交时临时给身份、关签名 */
const ug = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env: userEnv(), maxBuffer: 64 << 20 }).toString()
const commit = (msg: string, cwd = repo) =>
  ug(['-c', 'user.name=u', '-c', 'user.email=u@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', msg], cwd)
const write = (p: string, s: string | Buffer) => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, s)
}
const R = (p: string) => join(repo, p)
const tree = (ref: string) => ug(['ls-tree', '-r', '--name-only', '-z', ref]).split('\0').filter(Boolean)
const show = (ref: string, p: string) => ug(['show', `${ref}:${p}`])
const hidden = () => ug(['for-each-ref', '--format=%(refname)', 'refs/mffai']).split('\n').filter(Boolean)

/** guardArgs 之后的子命令名 */
const sub = (a: string[]) => a.find((x, i) => x !== '-c' && a[i - 1] !== '-c')

function initRepo(cwd = repo) {
  ug(['init', '-q', '-b', 'main'], cwd)
}

describe('createGit timeout (Task 8 review I-4)', () => {
  it('resolves with -1 even when a helper keeps holding the pipes, and keeps what was read', async () => {
    const pidFile = join(root, 'helper.pid')
    // 超时要够 git 拉起别名(负载高时几百毫秒);sleep 比它长得多,不放开管道就一定超过断言的上限
    const g = createGit({ base: base(), extraEnv: injected(), timeoutMs: 2000 })
    const t0 = Date.now()
    try {
      const r = await g(['-c', `alias.hang=!echo early; echo $$ > '${pidFile}'; exec sleep 30`, 'hang'], { cwd: root })
      expect(r.code).toBe(-1)
      expect(r.stdout.toString()).toContain('early')
      expect(Date.now() - t0).toBeLessThan(10_000)
    } finally {
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
    }
  })

  it('a git that ends in time is untouched by the timer', async () => {
    const g = createGit({ base: base(), extraEnv: injected(), timeoutMs: 5000 })
    const r = await g(['--version'], { cwd: root })
    expect(r.code).toBe(0)
    expect(r.stdout.toString()).toContain('git version')
  })
})

describe('gitEnv', () => {
  it('drops every inherited GIT_* and sets the mff-ai identity', () => {
    const env = gitEnv({ PATH: '/bin', GIT_DIR: '/x', git_work_tree: '/y', GIT_INDEX_FILE: '/z', GIT_AUTHOR_NAME: 'me', HOME: '/h' })
    expect(env.PATH).toBe('/bin')
    expect(env.HOME).toBe('/h')
    expect(Object.keys(env).filter(k => k.toUpperCase() === 'GIT_DIR' || k.toUpperCase() === 'GIT_WORK_TREE' || k === 'GIT_INDEX_FILE')).toEqual([])
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: 'mff-ai',
      GIT_AUTHOR_EMAIL: 'mff-ai@localhost',
      GIT_COMMITTER_NAME: 'mff-ai',
      GIT_COMMITTER_EMAIL: 'mff-ai@localhost',
      GIT_TERMINAL_PROMPT: '0',
    })
  })
})

describe('pinRepo', () => {
  it('records the top and git dirs by real path, the same from a subdirectory', async () => {
    initRepo()
    mkdirSync(R('sub'))
    const pin = (await pinRepo(R('sub'), git())) as PinnedRepo
    expect(pin).toMatchObject({ kind: 'repo', top: repo, gitDir: join(repo, '.git'), commonDir: join(repo, '.git') })
    expect(pinIntact(pin)).toBe(true)
    expect(git_.repoPrefix(pin, R('sub'))).toBe('sub/')
    expect(git_.repoPrefix(pin, repo)).toBe('')
    expect(() => git_.repoPrefix(pin, tmp)).toThrow()
  })

  it('no repo, and git failing or missing, are all "none"', async () => {
    expect(await pinRepo(tmp, git())).toEqual(NO_REPO)
    expect(await pinRepo(tmp, (async () => { throw new Error('spawn git ENOENT') }) as Git)).toEqual(NO_REPO)
  })

  describe('a planted shape is no repo (re-review R1-I1)', () => {
    const evil = (dir: string) => {
      write(join(dir, 'evil/HEAD'), 'ref: refs/heads/main\n')
      mkdirSync(join(dir, 'evil/objects'), { recursive: true })
      mkdirSync(join(dir, 'evil/refs'), { recursive: true })
      write(join(dir, 'evil/config'), '[core]\n')
    }

    it('.git file with gitdir inside its own tree, in a plain dir and in a repo subdirectory', async () => {
      const plain = join(root, 'plain')
      evil(plain)
      write(join(plain, '.git'), 'gitdir: evil\n')
      expect(await pinRepo(plain, git())).toEqual(NO_REPO)
      initRepo()
      evil(R('sub'))
      write(R('sub/.git'), 'gitdir: evil\n')
      expect(await pinRepo(R('sub'), git())).toEqual(NO_REPO)
      expect(await pinRepo(repo, git())).toMatchObject({ kind: 'repo', top: repo })
    })

    it('a commondir file leading to a directory inside the tree', async () => {
      initRepo()
      evil(repo)
      write(join(repo, '.git', 'commondir'), '../evil\n')
      expect(await pinRepo(repo, git())).toEqual(NO_REPO)
    })

    it('a git dir inside the data dir or ~/.qoder, also through a linked spelling', async () => {
      const data = join(root, 'data')
      const plain = join(root, 'plain')
      mkdirSync(plain)
      evil(data)
      write(join(plain, '.git'), `gitdir: ${join(data, 'evil')}\n`)
      expect((await pinRepo(plain, git())).kind).toBe('repo')
      expect(await pinRepo(plain, git(), { untrusted: [data] })).toEqual(NO_REPO)
      symlinkSync(data, join(root, 'data-link'))
      expect(await pinRepo(plain, git(), { untrusted: [join(root, 'data-link')] })).toEqual(NO_REPO)
    })

    it('still pins: a plain repo, a linked worktree, a worktree inside the repo, a submodule, a linked .git dir', async () => {
      initRepo()
      write(R('a.txt'), 'a\n')
      ug(['add', '.'])
      commit('init')
      const linked = join(root, 'linked')
      ug(['worktree', 'add', '-q', '--detach', linked])
      expect(await pinRepo(linked, git(), { untrusted: [join(root, 'data')] })).toMatchObject({ kind: 'repo', top: linked })
      const inner = R('wts/x')
      ug(['worktree', 'add', '-q', '--detach', inner])
      expect(await pinRepo(inner, git())).toMatchObject({ kind: 'repo', top: inner })
      const lib = join(root, 'lib')
      mkdirSync(lib)
      ug(['init', '-q'], lib)
      write(join(lib, 'l.txt'), 'l\n')
      ug(['add', '.'], lib)
      commit('lib', lib)
      ug(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor'])
      expect(await pinRepo(R('vendor'), git())).toMatchObject({ kind: 'repo', top: R('vendor'), gitDir: join(repo, '.git', 'modules', 'vendor') })
      const apart = join(root, 'apart')
      mkdirSync(apart)
      ug(['init', '-q', `--separate-git-dir=${join(root, 'apart.git')}`], apart)
      expect(await pinRepo(apart, git())).toMatchObject({ kind: 'repo', top: apart, gitDir: join(root, 'apart.git') })
    })
  })

  it('a stored pin of the wrong shape reads back as no repo', async () => {
    initRepo()
    const pin = await pinRepo(repo, git())
    expect(parsePin(JSON.parse(JSON.stringify(pin)))).toEqual(pin)
    for (const bad of [undefined, null, 'x', { kind: 'repo' }, { ...pin, top: 'relative' }, { ...pin, ids: {} }]) expect(parsePin(bad)).toEqual(NO_REPO)
  })
})

describe('the pinned repo (final review C-1)', () => {
  const ref = 'refs/mffai/x/t-start'
  const mark = () => join(root, 'filter-ran')
  /** 能在沙箱里写出来的一整套:.git 文件 → evil,里面配了跑 touch 的过滤器,payload 走这个过滤器 */
  const plant = (dir: string) => {
    write(join(dir, 'evil/HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(dir, 'evil/objects'), { recursive: true })
    mkdirSync(join(dir, 'evil/refs'), { recursive: true })
    write(join(dir, 'evil/config'), `[filter "x"]\n\tclean = /usr/bin/touch ${mark()}\n`)
    write(join(dir, '.git'), 'gitdir: evil\n')
    write(join(dir, '.gitattributes'), 'payload filter=x\n')
    write(join(dir, 'payload'), 'x\n')
  }
  const seeded = async () => {
    initRepo()
    write(R('sub/keep.txt'), 'k\n')
    ug(['add', '.'])
    commit('init')
    return (await pinRepo(R('sub'), git())) as PinnedRepo
  }

  it('every git call carries the pinned GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR and runs at the top', async () => {
    const pin = await seeded()
    const seen: Parameters<Git>[1][] = []
    const g = git()
    const spy: Git = (a, o) => (seen.push(o), g(a, o))
    const r = await git_.takeSnapshot(R('sub'), ref, spy, { pin })
    expect(r.ref).toBe(ref)
    await git_.changes(R('sub'), ref, ref, spy, { pin })
    await git_.refExists(ref, spy, { pin })
    await git_.pruneRefs('refs/mffai/x', 5, spy, { pin })
    expect(seen.length).toBeGreaterThan(5)
    for (const o of seen) {
      expect(o.env).toMatchObject({ GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: repo, GIT_COMMON_DIR: join(repo, '.git') })
      expect(o.cwd).toBe(repo)
    }
  })

  it('a planted repo in a subdirectory is not the repo: its filter never runs', async () => {
    const pin = await seeded()
    plant(R('sub'))
    const r = await git_.takeSnapshot(R('sub'), ref, git(), { pin })
    expect(existsSync(mark())).toBe(false)
    // git 把它当嵌套仓库,没提交就拍不了;拍得了也不进去
    expect(r.ref === ref || r.reason === 'error').toBe(true)
    expect(hidden().filter(h => h !== ref)).toEqual([])
    expect(existsSync(R('sub/evil/refs/mffai'))).toBe(false)
  })

  it('pinned "none" never runs git, even when a valid repo appears later', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    const pin = await pinRepo(dir, git())
    expect(pin).toEqual(NO_REPO)
    plant(dir)
    let calls = 0
    const spy: Git = () => { calls++; throw new Error('git ran') }
    expect(await git_.takeSnapshot(dir, ref, spy, { pin })).toEqual({ reason: 'not_git' })
    await expect(git_.changes(dir, 'a', 'b', spy, { pin })).rejects.toThrow(/不是 git/)
    await expect(git_.restore(dir, 'a', [], spy, { pin })).rejects.toThrow(/不是 git/)
    await expect(git_.refExists('a', spy, { pin })).rejects.toThrow(/不是 git/)
    expect(calls).toBe(0)
    expect(existsSync(mark())).toBe(false)
  })

  const unsafeNow = async (pin: PinnedRepo) => {
    let calls = 0
    const spy: Git = () => { calls++; throw new Error('git ran') }
    expect(await git_.takeSnapshot(R('sub'), ref, spy, { pin })).toEqual({ reason: 'unsafe_repo' })
    await expect(git_.changes(R('sub'), 'a', 'b', spy, { pin })).rejects.toThrow(/unsafe_repo/)
    await expect(git_.restore(R('sub'), 'a', [], spy, { pin })).rejects.toThrow(/unsafe_repo/)
    expect(calls).toBe(0)
  }

  it('.git replaced by a file, by a symlink, or moved → unsafe_repo, git never runs', async () => {
    const pin = await seeded()
    expect(pinIntact(pin)).toBe(true)
    const aside = join(root, 'aside')
    renameSync(join(repo, '.git'), aside)
    writeFileSync(join(repo, '.git'), 'gitdir: evil\n')
    await unsafeNow(pin)
    rmSync(join(repo, '.git'))
    symlinkSync(aside, join(repo, '.git'))
    await unsafeNow(pin)
    rmSync(join(repo, '.git'))
    await unsafeNow(pin)
  })

  it('a .git directory rebuilt with the same path is a different repo', async () => {
    const pin = await seeded()
    renameSync(join(repo, '.git'), join(root, 'aside'))
    ug(['init', '-q'])
    await unsafeNow(pin)
  })

  it('a commondir file inside the git dir → unsafe_repo', async () => {
    const pin = await seeded()
    writeFileSync(join(repo, '.git', 'commondir'), '../evil\n')
    await unsafeNow(pin)
  })

  it('a repo moved away → unsafe_repo', async () => {
    const pin = await seeded()
    renameSync(repo, join(root, 'moved'))
    mkdirSync(R('sub'), { recursive: true })
    await unsafeNow(pin)
  })

  it('a linked worktree keeps its own git dir, and its commondir has to lead back', async () => {
    await seeded()
    const linked = join(root, 'linked')
    ug(['worktree', 'add', '-q', '--detach', linked])
    const pin = (await pinRepo(linked, git())) as PinnedRepo
    expect(pin.gitDir).toBe(join(repo, '.git', 'worktrees', 'linked'))
    expect(pin.commonDir).toBe(join(repo, '.git'))
    expect((await git_.takeSnapshot(linked, ref, git(), { pin })).ref).toBe(ref)
    writeFileSync(join(pin.gitDir, 'commondir'), `${join(root, 'evil')}\n`)
    expect(pinIntact(pin)).toBe(false)
  })
})

describe('Review Focus 4: snapshots never touch the user git state', () => {
  it('start / end snapshot and restore leave index, status, HEAD, branches and stash byte-identical', async () => {
    initRepo()
    write(R('.gitignore'), 'ignored.log\n')
    write(R('staged.txt'), 'staged v1\n')
    write(R('b.txt'), 'b v1\n')
    write(R('stashme.txt'), 'stash v1\n')
    ug(['add', '.'])
    commit('init')
    ug(['branch', 'feature'])
    write(R('stashme.txt'), 'stash v2\n')
    ug(['-c', 'user.name=u', '-c', 'user.email=u@example.invalid', 'stash', 'push', '-q', '-m', 'mine'])
    // 用户配置:强制签名但 gpg 不存在;没有 user.email,且不许自动猜身份
    ug(['config', 'commit.gpgSign', 'true'])
    ug(['config', 'gpg.program', '/nonexistent'])
    ug(['config', 'user.useConfigOnly', 'true'])
    // 已暂存未提交、未暂存、未跟踪、被忽略
    write(R('staged.txt'), 'staged v2\n')
    ug(['add', 'staged.txt'])
    write(R('b.txt'), 'b unstaged\n')
    write(R('untracked.txt'), 'u\n')
    write(R('ignored.log'), 'secret\n')

    const state = () => ({
      cached: ug(['diff', '--cached']),
      status: ug(['status', '--porcelain']),
      head: ug(['rev-parse', 'HEAD']),
      branch: ug(['branch']),
      stash: ug(['stash', 'list']),
      config: ug(['config', '--local', '--list']),
      worktrees: ug(['worktree', 'list', '--porcelain']),
      dotGit: readdirSync(R('.git')).sort(),
    })
    const before = state()
    const index = () => readFileSync(R('.git/index'))
    const idx0 = index()
    const g = git()

    const start = await takeSnapshot(repo, 'refs/mffai/snapshots/s1/t1-start', g, { tmpDir: tmp })
    expect(start).toEqual({ ref: 'refs/mffai/snapshots/s1/t1-start' })
    // 本轮:改了用户未暂存的文件,加了一个新文件
    write(R('b.txt'), 'b by turn\n')
    write(R('new.txt'), 'n\n')
    const end = await takeSnapshot(repo, 'refs/mffai/snapshots/s1/t1-end', g, { tmpDir: tmp })
    expect(end.ref).toBe('refs/mffai/snapshots/s1/t1-end')
    const files = await changes(repo, start.ref!, end.ref!, g)
    expect(files).toEqual([
      { path: 'b.txt', status: 'M' },
      { path: 'new.txt', status: 'A' },
    ])
    expect((await takeSnapshot(repo, 'refs/mffai/snapshots/s1/t1-pre-rollback', g, { tmpDir: tmp })).ref).toBeDefined()
    await restore(repo, start.ref!, files, g)

    expect(index().equals(idx0)).toBe(true)
    expect(state()).toEqual(before)
    expect(readFileSync(R('b.txt'), 'utf8')).toBe('b unstaged\n')
    expect(existsSync(R('new.txt'))).toBe(false)
    // 快照内容:工作区的样子,不含被忽略的文件;父提交 = HEAD
    const t = tree(start.ref!)
    expect(t).toContain('untracked.txt')
    expect(t).not.toContain('ignored.log')
    expect(show(start.ref!, 'staged.txt')).toBe('staged v2\n')
    expect(show(start.ref!, 'b.txt')).toBe('b unstaged\n')
    expect(ug(['rev-parse', `${start.ref}^`])).toBe(before.head)
    expect(ug(['log', '-1', '--format=%an <%ae>', start.ref!]).trim()).toBe('mff-ai <mff-ai@localhost>')
    expect(readdirSync(tmp)).toEqual([])
  })
})

describe('Review Focus 5: restore puts back only that turn files', () => {
  it('restores a modified file, a deleted exec file, removes an added file and leaves later user edits alone', async () => {
    initRepo()
    write(R('a.txt'), 'a v1\n')
    write(R('b.txt'), 'b v1\n')
    write(R('exec.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(R('exec.sh'), 0o755)
    write(R('keep.txt'), 'keep\n')
    ug(['add', '.'])
    commit('init')
    const g = git()
    const start = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })
    write(R('a.txt'), 'a by turn\n')
    unlinkSync(R('exec.sh'))
    write(R('dir/new.txt'), 'new\n')
    const end = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-end', g, { tmpDir: tmp })
    // 轮结束后用户自己的改动
    write(R('later.txt'), 'later\n')
    write(R('b.txt'), 'b by user\n')

    const files = await changes(repo, start.ref!, end.ref!, g)
    expect(files).toEqual([
      { path: 'a.txt', status: 'M' },
      { path: 'dir/new.txt', status: 'A' },
      { path: 'exec.sh', status: 'D' },
    ])
    const pre = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-pre-rollback', g, { tmpDir: tmp })
    expect(tree(pre.ref!)).toContain('later.txt')
    await restore(repo, start.ref!, files, g)

    expect(readFileSync(R('a.txt'), 'utf8')).toBe('a v1\n')
    expect(readFileSync(R('exec.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
    expect(statSync(R('exec.sh')).mode & 0o777).toBe(0o777 & ~process.umask())
    expect(statSync(R('a.txt')).mode & 0o111).toBe(0)
    expect(existsSync(R('dir/new.txt'))).toBe(false)
    expect(existsSync(R('dir'))).toBe(false)
    expect(readFileSync(R('later.txt'), 'utf8')).toBe('later\n')
    expect(readFileSync(R('b.txt'), 'utf8')).toBe('b by user\n')
    expect(readFileSync(R('keep.txt'), 'utf8')).toBe('keep\n')
  })

  it('symlinks round-trip: a link replaced by a file comes back as the link, an added link is removed without following it', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    symlinkSync('a.txt', R('link'))
    ug(['add', '.'])
    commit('init')
    const outside = join(root, 'outside')
    write(join(outside, 'f.txt'), 'outside\n')
    const g = git()
    const start = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })
    unlinkSync(R('link'))
    write(R('link'), 'now a file\n')
    symlinkSync(outside, R('out'))
    const end = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-end', g, { tmpDir: tmp })
    const files = await changes(repo, start.ref!, end.ref!, g)
    expect(files).toEqual([
      { path: 'link', status: 'T' },
      { path: 'out', status: 'A' },
    ])
    await restore(repo, start.ref!, files, g)
    expect(lstatSync(R('link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(R('link'))).toBe('a.txt')
    expect(existsSync(R('out'))).toBe(false)
    expect(readFileSync(join(outside, 'f.txt'), 'utf8')).toBe('outside\n')
  })

  it('does not write through a directory that became a symlink out of cwd', async () => {
    initRepo()
    write(R('d/f.txt'), 'inside\n')
    ug(['add', '.'])
    commit('init')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const g = git()
    const start = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })
    rmSync(R('d'), { recursive: true })
    symlinkSync(outside, R('d'))
    await expect(restore(repo, start.ref!, [{ path: 'd/f.txt', status: 'D' }], g)).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
    // 删除同样不穿过链接:outside/new.txt 不会被当成本轮新增的 d/new.txt 删掉
    write(join(outside, 'new.txt'), 'keep\n')
    await expect(restore(repo, start.ref!, [{ path: 'd/new.txt', status: 'A' }], g)).rejects.toThrow()
    expect(readFileSync(join(outside, 'new.txt'), 'utf8')).toBe('keep\n')
  })

  it('refuses paths under .git and paths with dot segments', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    ug(['add', '.'])
    commit('init')
    const g = git()
    const start = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })
    await expect(restore(repo, start.ref!, [{ path: '.git/hooks/pre-commit', status: 'A' }], g)).rejects.toThrow()
    await expect(restore(repo, start.ref!, [{ path: '../x', status: 'A' }], g)).rejects.toThrow()
    expect(existsSync(R('.git/HEAD'))).toBe(true)
  })
})

describe('takeSnapshot edge cases', () => {
  it('works in an unborn repo (no HEAD, no index) and with only a staged file', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    const g = git()
    const s1 = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t1-start', g, { tmpDir: tmp })
    expect(s1.ref).toBeDefined()
    expect(tree(s1.ref!)).toEqual(['a.txt'])
    expect(() => execFileSync('git', ['rev-parse', '-q', '--verify', `${s1.ref}^`], { cwd: repo, env: userEnv(), stdio: 'pipe' })).toThrow()
    write(R('b.txt'), 'b\n')
    ug(['add', 'b.txt'])
    const s2 = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t2-start', g, { tmpDir: tmp })
    expect(tree(s2.ref!)).toEqual(['a.txt', 'b.txt'])
    expect(ug(['status', '--porcelain'])).toBe('A  b.txt\n?? a.txt\n')
  })

  it('a subdirectory cwd captures only its prefix; changes outside it are not reported', async () => {
    initRepo()
    write(R('sub/x.txt'), 'x1\n')
    write(R('other/y.txt'), 'y1\n')
    ug(['add', '.'])
    commit('init')
    write(R('other/untracked.txt'), 'u\n')
    const cwd = R('sub')
    const g = git()
    const start = await takeSnapshot(cwd, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })
    expect(tree(start.ref!)).not.toContain('other/untracked.txt')
    write(R('sub/x.txt'), 'x2\n')
    write(R('other/y.txt'), 'y2\n')
    const end = await takeSnapshot(cwd, 'refs/mffai/snapshots/s/t-end', g, { tmpDir: tmp })
    const files = await changes(cwd, start.ref!, end.ref!, g)
    expect(files).toEqual([{ path: 'sub/x.txt', status: 'M' }])
    await restore(cwd, start.ref!, files, g)
    expect(readFileSync(R('sub/x.txt'), 'utf8')).toBe('x1\n')
    expect(readFileSync(R('other/y.txt'), 'utf8')).toBe('y2\n')
  })

  it('a 21 MB untracked file → too_large and no ref; an ignored one does not count', async () => {
    initRepo()
    write(R('.gitignore'), 'big.ignored\n')
    write(R('big.ignored'), Buffer.alloc(21 << 20))
    const g = git()
    expect((await takeSnapshot(repo, 'refs/mffai/snapshots/s/t1-start', g, { tmpDir: tmp })).ref).toBeDefined()
    write(R('big.bin'), Buffer.alloc(21 << 20))
    expect(await takeSnapshot(repo, 'refs/mffai/snapshots/s/t2-start', g, { tmpDir: tmp })).toEqual({ reason: 'too_large' })
    expect(hidden()).toEqual(['refs/mffai/snapshots/s/t1-start'])
    expect(readdirSync(tmp)).toEqual([])
  })

  it('the total untracked size limit also applies', async () => {
    initRepo()
    write(R('a'), '123456')
    write(R('b'), '123456')
    expect(await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', git(), { tmpDir: tmp, maxTotalBytes: 10 })).toEqual({ reason: 'too_large' })
    expect(hidden()).toEqual([])
  })

  it('not a git dir → not_git', async () => {
    expect(await takeSnapshot(tmp, 'refs/mffai/snapshots/s/t-start', git(), { tmpDir: tmp })).toEqual({ reason: 'not_git' })
  })

  it('a failing step → error, no ref, and the temp index is removed', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    ug(['add', '.'])
    commit('init')
    const real = git()
    const failing: Git = (args, o) => (sub(args) === 'write-tree' ? Promise.resolve({ code: 1, stdout: Buffer.alloc(0), stderr: 'boom' }) : real(args, o))
    expect(await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', failing, { tmpDir: tmp })).toEqual({ reason: 'error' })
    const throwing: Git = (args, o) => (sub(args) === 'commit-tree' ? Promise.reject(new Error('spawn failed')) : real(args, o))
    expect(await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', throwing, { tmpDir: tmp })).toEqual({ reason: 'error' })
    expect(hidden()).toEqual([])
    expect(readdirSync(tmp)).toEqual([])
  })

  it('git not on PATH → error, no throw', async () => {
    initRepo()
    const g = createGit({ base: { ...base(), PATH: join(root, 'nobin') }, extraEnv: injected() })
    const pin = await pinRepo(repo, git())
    expect(await git_.takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp, pin })).toEqual({ reason: 'error' })
    expect(readdirSync(tmp)).toEqual([])
  })

  it('the temp index lives in tmpDir while git runs', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    const real = git()
    const seen: string[] = []
    const spy: Git = (args, o) => {
      if (o.env?.GIT_INDEX_FILE) seen.push(o.env.GIT_INDEX_FILE)
      return real(args, o)
    }
    expect((await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', spy, { tmpDir: tmp })).ref).toBeDefined()
    expect(seen.length).toBeGreaterThan(0)
    for (const p of seen) expect(p.startsWith(tmp + '/') || p.startsWith(tmp + '\\')).toBe(true)
    expect(readdirSync(tmp)).toEqual([])
  })

  it('an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE in the base env is ignored', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    const bogus = join(root, 'bogus')
    const g = createGit({ base: { ...base(), GIT_DIR: bogus, GIT_WORK_TREE: root, GIT_INDEX_FILE: join(root, 'bogus-index') }, extraEnv: injected() })
    const s = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })
    expect(s.ref).toBeDefined()
    expect(tree(s.ref!)).toEqual(['a.txt'])
    expect(existsSync(bogus)).toBe(false)
    expect(existsSync(join(root, 'bogus-index'))).toBe(false)
  })
})

describe('review fixes', () => {
  const g0 = () => git()

  it('I1: user hooks and fsmonitor never run during snapshot, changes, restore and pruneRefs', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    ug(['add', '.'])
    commit('init')
    const marker = join(root, 'marker')
    const script = join(root, 'hook.sh')
    writeFileSync(script, `#!/bin/sh\necho "$0" >> '${marker}'\nexit 0\n`)
    chmodSync(script, 0o755)
    // 钩子都是指向同一脚本的符号链接:macOS 首次执行每个新可执行文件要被扫描约 0.5 s,
    // 满载时这些扫描排队,5 个新文件就能把本测试拖过超时;一个文件只扫一次
    for (const h of ['post-index-change', 'reference-transaction', 'pre-commit', 'post-commit']) symlinkSync(script, R(`.git/hooks/${h}`))
    ug(['config', 'core.fsmonitor', script])
    // 对照:用户自己的 git 操作确实会触发这些钩子
    write(R('a.txt'), 'a2\n')
    ug(['add', 'a.txt'])
    ug(['update-ref', 'refs/heads/probe', 'HEAD'])
    expect(readFileSync(marker, 'utf8')).toMatch(/post-index-change/)
    expect(readFileSync(marker, 'utf8')).toMatch(/reference-transaction/)
    rmSync(marker)

    const g = g0()
    const start = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })
    write(R('a.txt'), 'a3\n')
    const end = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-end', g, { tmpDir: tmp })
    const files = await changes(repo, start.ref!, end.ref!, g, { tmpDir: tmp })
    await restore(repo, start.ref!, files, g, { tmpDir: tmp })
    await pruneRefs(repo, 'refs/mffai/snapshots/s', 0, g, { tmpDir: tmp })
    expect(start.ref && end.ref).toBeTruthy()
    expect(files).toEqual([{ path: 'a.txt', status: 'M' }])
    expect(readFileSync(R('a.txt'), 'utf8')).toBe('a2\n')
    expect(hidden()).toEqual([])
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(tmp)).toEqual([])
  }, 60_000) // 单测约 4 s,但要起几十个 git 进程:全量并行时是真实负载,给它自己的上限

  it('I2: the copied index keeps its mtime, so a same-size edit in the same tick is still captured', async () => {
    initRepo()
    const T = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
    write(R('x.txt'), 'x1\n')
    utimesSync(R('x.txt'), T, T)
    ug(['add', '.'])
    commit('init')
    write(R('x.txt'), 'x2\n')
    utimesSync(R('x.txt'), T, T)
    utimesSync(R('.git/index'), T, T)
    const s = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g0(), { tmpDir: tmp })
    expect(show(s.ref!, 'x.txt')).toBe('x2\n')
  })

  it('I3: restore writes the checkout form (autocrlf line endings, smudge filter)', async () => {
    initRepo()
    ug(['config', 'core.autocrlf', 'true'])
    // 只有 git-lfs、git-crypt 能跑:拿这个名字的脚本验检出转换
    const lfs = join(root, 'bin', 'git-lfs')
    write(lfs, '#!/bin/sh\nexec /usr/bin/tr a-zA-Z n-za-mN-ZA-M\n')
    chmodSync(lfs, 0o755)
    ug(['config', 'filter.rot.clean', lfs])
    ug(['config', 'filter.rot.smudge', lfs])
    write(R('.gitattributes'), 'secret.txt filter=rot\n')
    const crlf = Buffer.from('line1\r\nline2\r\n')
    write(R('crlf.txt'), crlf)
    write(R('secret.txt'), 'hello\r\n')
    ug(['add', '.'])
    commit('init')
    expect(ug(['cat-file', 'blob', 'HEAD:secret.txt'])).toBe('uryyb\n')
    const g = g0()
    const start = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })
    write(R('crlf.txt'), 'changed\r\n')
    write(R('secret.txt'), 'changed\n')
    const end = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-end', g, { tmpDir: tmp })
    const files = await changes(repo, start.ref!, end.ref!, g)
    expect(files.map(f => f.path)).toEqual(['crlf.txt', 'secret.txt'])
    await restore(repo, start.ref!, files, g)
    expect(readFileSync(R('crlf.txt')).equals(crlf)).toBe(true)
    expect(readFileSync(R('secret.txt'), 'utf8')).toBe('hello\r\n')
  })

  it('M1: a split index in the user repo gets no new sharedindex files', async () => {
    initRepo()
    ug(['config', 'core.splitIndex', 'true'])
    write(R('a.txt'), 'a\n')
    ug(['add', '.'])
    commit('init')
    const shared = () => readdirSync(R('.git')).filter(n => n.startsWith('sharedindex.')).sort()
    const before = shared()
    expect(before.length).toBeGreaterThan(0)
    write(R('b.txt'), 'b\n')
    const s = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g0(), { tmpDir: tmp })
    expect(tree(s.ref!)).toEqual(['a.txt', 'b.txt'])
    expect(shared()).toEqual(before)
  })

  it('M2: assume-unchanged files are still captured from the worktree; the user flag stays', async () => {
    initRepo()
    write(R('f.txt'), 'f1\n')
    ug(['add', '.'])
    commit('init')
    ug(['update-index', '--assume-unchanged', 'f.txt'])
    write(R('f.txt'), 'changed\n')
    const s = await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g0(), { tmpDir: tmp })
    expect(show(s.ref!, 'f.txt')).toBe('changed\n')
    expect(ug(['ls-files', '-v', 'f.txt'])).toBe('h f.txt\n')
  })

  it('M3: a submodule entry is reported as not restored', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    ug(['add', '.'])
    commit('init')
    const head = ug(['rev-parse', 'HEAD']).trim()
    ug(['update-index', '--add', '--cacheinfo', `160000,${head},mod`])
    commit('gitlink')
    await expect(restore(repo, 'HEAD', [{ path: 'mod', status: 'M' }], g0())).rejects.toThrow(/子模块未回滚/)
  })
})

describe('takeSnapshot createOnly', () => {
  it('never overwrites an existing ref', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    ug(['add', '.'])
    commit('init')
    const g = git()
    const ref = 'refs/mffai/snapshots/s/t-pre-rollback-1'
    expect(await takeSnapshot(repo, ref, g, { tmpDir: tmp, createOnly: true })).toEqual({ ref })
    const first = ug(['rev-parse', ref]).trim()
    write(R('a.txt'), 'changed\n')
    expect(await takeSnapshot(repo, ref, g, { tmpDir: tmp, createOnly: true })).toEqual({ reason: 'error' })
    expect(ug(['rev-parse', ref]).trim()).toBe(first)
    expect(readdirSync(tmp)).toEqual([])
  })
})

describe('pruneRefs', () => {
  it('keeps the newest 50 of 52 turns and leaves other sessions alone', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    ug(['add', '.'])
    commit('init')
    const g = git()
    const treeSha = ug(['rev-parse', 'HEAD^{tree}']).trim()
    // 提交时间各不相同的快照提交:写成对象文件,一次 hash-object、一次 update-ref --stdin
    const refs: [string, number][] = []
    for (let i = 0; i < 52; i++) refs.push([`refs/mffai/snapshots/s1/t${i}-start`, i * 10], [`refs/mffai/snapshots/s1/t${i}-end`, i * 10 + 1])
    // pre-rollback 带时间戳后缀;最新一轮的也算在它自己名下,不单独占一轮
    refs.push(['refs/mffai/snapshots/s1/t1-pre-rollback', 15], ['refs/mffai/snapshots/s1/t51-pre-rollback-1700000000999', 600], ['refs/mffai/snapshots/s2/t0-start', 0])
    const objs = refs.map(([, sec], i) => {
      const who = `x <x@example.invalid> ${1_700_000_000 + sec} +0000`
      const f = join(root, `commit-${i}`)
      writeFileSync(f, `tree ${treeSha}\nauthor ${who}\ncommitter ${who}\n\nx\n`)
      return f
    })
    const shas = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin-paths'], { cwd: repo, env: userEnv(), input: objs.join('\n') + '\n' })
      .toString()
      .trim()
      .split('\n')
    execFileSync('git', ['update-ref', '--stdin'], { cwd: repo, env: userEnv(), input: refs.map(([r], i) => `create ${r} ${shas[i]}\n`).join('') })
    await pruneRefs(repo, 'refs/mffai/snapshots/s1', 50, g)
    const left = hidden()
    expect(left).toContain('refs/mffai/snapshots/s2/t0-start')
    const turns = new Set(left.filter(r => r.startsWith('refs/mffai/snapshots/s1/')).map(r => r.slice('refs/mffai/snapshots/s1/'.length).replace(/-(start|end|pre-rollback(?:-\d+)?)$/, '')))
    expect(turns.size).toBe(50)
    expect(left).toContain('refs/mffai/snapshots/s1/t51-pre-rollback-1700000000999')
    expect(turns.has('t0')).toBe(false)
    expect(turns.has('t1')).toBe(false)
    expect(turns.has('t2')).toBe(true)
    expect(turns.has('t51')).toBe(true)
    expect(left.filter(r => r.startsWith('refs/mffai/snapshots/s1/t1-'))).toEqual([])
  })
})

describe('a nested repo never gets entered by our add -A (Task 9 review C1)', () => {
  const g = () => createGit({ base: base(), extraEnv: injected() })
  const lsTree = (ref: string, p: string) => ug(['ls-tree', ref, p])
  const filter = (mark: string) => `touch "${mark}"; cat`

  /** Route A:新建的嵌套仓库,配置在 --separate-git-dir 里,绕开沙箱对 .git/config 的拦截;gitlink 写进索引 */
  const routeA = (mark: string) => {
    ug(['init', '-q', '--separate-git-dir', R('.sg'), R('sub')])
    write(R('sub/f.txt'), 'one\n')
    ug(['add', 'f.txt'], R('sub'))
    commit('s', R('sub'))
    const head = ug(['rev-parse', 'HEAD'], R('sub')).trim()
    ug(['config', 'filter.x.clean', filter(mark)], R('sub'))
    write(R('sub/.gitattributes'), '* filter=x\n')
    write(R('sub/f.txt'), 'ONE\n') // 同样大小:git 只能读内容
    ug(['add', 'sub'])
    return head
  }

  /** Route B:仓库里本来就有 gitlink,不用写索引:在那个目录建仓库,HEAD 写成 gitlink 的 sha,对象经 alternates 拿到 */
  const routeB = (mark: string) => {
    const source = join(root, 'source')
    mkdirSync(source)
    initRepo(source)
    write(join(source, 'f.txt'), 'one\n')
    ug(['add', 'f.txt'], source)
    commit('s', source)
    const sha = ug(['rev-parse', 'HEAD'], source).trim()
    ug(['update-index', '--add', '--cacheinfo', `160000,${sha},sub`])
    commit('link')
    mkdirSync(R('sub'))
    ug(['init', '-q', '--separate-git-dir', R('.sg2'), R('sub')])
    write(R('.sg2/objects/info/alternates'), `${join(source, '.git', 'objects')}\n`)
    write(R('.sg2/HEAD'), `${sha}\n`)
    ug(['config', 'filter.x.clean', filter(mark)], R('sub'))
    ug(['reset', '-q', '--hard'], R('sub'))
    write(R('sub/.gitattributes'), '* filter=x\n')
    write(R('sub/f.txt'), 'ONE\n')
    return sha
  }

  beforeEach(() => {
    initRepo()
    write(R('a.txt'), 'a\n')
    ug(['add', 'a.txt'])
    commit('init')
  })

  it('Route A: the filter does not run, and the gitlink is recorded at the nested HEAD', async () => {
    const mark = join(root, 'ran')
    const head = routeA(mark)
    const r = await takeSnapshot(repo, 'refs/mffai/x/t-end', g(), { tmpDir: tmp })
    expect(r.reason).toBeUndefined()
    expect(existsSync(mark)).toBe(false)
    expect(lsTree(r.ref!, 'sub')).toContain(`160000 commit ${head}`)
  })

  it('Route B: the filter does not run, and the gitlink stays', async () => {
    const mark = join(root, 'ran')
    const sha = routeB(mark)
    const r = await takeSnapshot(repo, 'refs/mffai/x/t-end', g(), { tmpDir: tmp })
    expect(r.reason).toBeUndefined()
    expect(existsSync(mark)).toBe(false)
    expect(lsTree(r.ref!, 'sub')).toContain(`160000 commit ${sha}`)
  })

  it('the user\'s index keeps the gitlink: only the temp index loses it', async () => {
    routeA(join(root, 'ran'))
    const before = readFileSync(R('.git/index')).toString('hex')
    await takeSnapshot(repo, 'refs/mffai/x/t-end', g(), { tmpDir: tmp })
    expect(readFileSync(R('.git/index')).toString('hex')).toBe(before)
    expect(ug(['ls-files', '-s', 'sub'])).toContain('160000')
  })

  it('an unpopulated gitlink stays as it is, not recorded as deleted', async () => {
    const sha = '1'.repeat(40)
    ug(['update-index', '--add', '--cacheinfo', `160000,${sha},vendor/lib`])
    commit('link')
    mkdirSync(R('vendor/lib'), { recursive: true }) // git submodule init 之后、update 之前的样子
    const r = await takeSnapshot(repo, 'refs/mffai/x/t-end', g(), { tmpDir: tmp })
    expect(lsTree(r.ref!, 'vendor/lib')).toContain(`160000 commit ${sha}`)
  })

  it('a real submodule that moved on is recorded at its new HEAD', async () => {
    routeA(join(root, 'ran'))
    ug(['config', '--unset', 'filter.x.clean'], R('sub'))
    commit('with sub')
    ug(['add', '-A'], R('sub'))
    commit('moved', R('sub'))
    const head = ug(['rev-parse', 'HEAD'], R('sub')).trim()
    const r = await takeSnapshot(repo, 'refs/mffai/x/t-end', g(), { tmpDir: tmp })
    expect(lsTree(r.ref!, 'sub')).toContain(`160000 commit ${head}`)
  })

  it('a gitlink outside a subdirectory session is left alone', async () => {
    const mark = join(root, 'ran')
    routeA(mark)
    mkdirSync(R('work'))
    write(R('work/w.txt'), 'w\n')
    const r = await takeSnapshot(R('work'), 'refs/mffai/x/t-end', g(), { tmpDir: tmp })
    expect(existsSync(mark)).toBe(false)
    expect(lsTree(r.ref!, 'sub')).toContain('160000 commit')
  })
})

describe('a filter a sandboxed CLI could rewrite never runs (Task 9 review C3)', () => {
  const g = () => createGit({ base: base(), extraEnv: injected() })
  const mark = () => join(root, 'filter-ran')

  const fixture = (key: 'clean' | 'smudge' | 'process' = 'clean', command = './tool.sh') => {
    initRepo()
    write(R('tool.sh'), `#!/bin/sh\ntouch "${mark()}"\ncat\n`)
    chmodSync(R('tool.sh'), 0o755)
    write(R('.gitattributes'), '*.dat filter=f\n')
    write(R('x.dat'), 'data\n')
    ug(['add', 'tool.sh', '.gitattributes'])
    commit('init')
    ug(['config', `filter.f.${key}`, command])
  }

  it.each(['clean', 'smudge', 'process'] as const)('takeSnapshot: a repo-relative %s → unsafe_filter, no ref, no marker', async key => {
    fixture(key)
    const r = await takeSnapshot(repo, 'refs/mffai/x/t-start', g(), { tmpDir: tmp })
    expect(r).toEqual({ reason: 'unsafe_filter' })
    expect(hidden()).toEqual([])
    expect(existsSync(mark())).toBe(false)
  })

  it('a filter in the user\'s global config counts too', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    writeFileSync(join(root, 'gitconfig'), '[filter "g"]\n\tclean = ./tool.sh\n')
    const r = await takeSnapshot(repo, 'refs/mffai/x/t-start', g(), { tmpDir: tmp })
    expect(r.reason).toBe('unsafe_filter')
  })

  it('changes and restore refuse too, and the marker never appears', async () => {
    initRepo()
    write(R('.gitattributes'), '*.dat filter=f\n')
    write(R('x.dat'), 'one\n')
    ug(['add', '-A'])
    commit('init')
    const a = (await takeSnapshot(repo, 'refs/mffai/x/t-start', g(), { tmpDir: tmp })).ref!
    write(R('x.dat'), 'two\n')
    const b = (await takeSnapshot(repo, 'refs/mffai/x/t-end', g(), { tmpDir: tmp })).ref!
    write(R('tool.sh'), `#!/bin/sh\ntouch "${mark()}"\ncat\n`)
    chmodSync(R('tool.sh'), 0o755)
    ug(['config', 'filter.f.smudge', './tool.sh'])
    await expect(changes(repo, a, b, g(), { tmpDir: tmp })).rejects.toThrow(/unsafe_filter/)
    await expect(restore(repo, a, [{ path: 'x.dat', status: 'M' }], g(), { tmpDir: tmp })).rejects.toThrow(/unsafe_filter/)
    expect(readFileSync(R('x.dat'), 'utf8')).toBe('two\n')
    expect(existsSync(mark())).toBe(false)
  })

  it('git-lfs at an absolute path outside the writable roots still runs', async () => {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git-lfs'), '#!/bin/sh\ncat\n')
    chmodSync(join(bin, 'git-lfs'), 0o755)
    fixture('clean', `${join(bin, 'git-lfs')} clean -- %f`)
    const r = await takeSnapshot(repo, 'refs/mffai/x/t-start', g(), { tmpDir: tmp })
    expect(r.reason).toBeUndefined()
    expect(r.ref).toBeDefined()
  })

  it('an absolute filter inside a writable root the caller named is refused', async () => {
    const writable = join(root, 'writable')
    mkdirSync(writable)
    fixture('clean', `${join(writable, 'tool.sh')} --x`)
    const r = await takeSnapshot(repo, 'refs/mffai/x/t-start', g(), { tmpDir: tmp, writableRoots: [writable] })
    expect(r.reason).toBe('unsafe_filter')
  })

  describe('unsafeFilterCommand', () => {
    const o = () => ({ top: repo, roots: [repo, join(root, 'w')], path: `/usr/bin:/bin:${join(root, 'pathdir')}` })

    it.each([
      ['./tool.sh'], ['../tool.sh'], ['tools/clean.sh'], ['"./tool.sh" clean'],
      // 名单外的一律不安全,哪怕落在沙箱写不到的地方、哪怕是从 stdin 读程序的那种(final review C-1)
      ['tclsh'], ['/usr/bin/tclsh'], ['osascript'], ['sqlite3 -batch'], ['expect'], ['cat'], ['tr a-z A-Z'], ['/usr/bin/tr a b'], ['"/usr/bin/tr" a b'], ['no-such-program-x'],
      ['/usr/local/bin/git-lfs-evil clean'], ['git-lfs.sh clean'],
      ['sh tool.sh'], ['bash -c cat'], ['python3 tools/clean.py'], ['python3 -m stripper'], ['/usr/bin/python3 -m stripper'], ['node x'], ['env FOO=1 tr a b'], ['make clean'],
      ['/usr/bin/tr a b; touch /x'], ['cat | sh'], ['$(./x)'], ['`./x`'], ['FOO=1 tr a b'], ['~/bin/x'], ['tr a b > out'], ['"$PWD/x"'], ['a\\ b'], ["'unterminated"],
      ['git-lfs a/b'], ['git-crypt -f tools/x'], ['git-lfs --file=tools/x'], ['"git-lfs" "a b"'], ['./git-lfs clean'], ['git-lfs/git-lfs clean'],
    ])('%s is unsafe', command => {
      expect(unsafeFilterCommand(command, o())).toBe(true)
    })

    it.each([
      ['git-lfs clean -- %f'], ['git-lfs smudge --skip -- %f'], ['git-lfs filter-process'], ['"git-crypt" clean'], ['"/usr/local/bin/git-crypt" smudge'], ["'/usr/local/bin/git-lfs' clean"], ['git-lfs clean --x=y -- "%f"'], ['/usr/local/bin/git-crypt clean'],
    ])('%s is fine', command => {
      expect(unsafeFilterCommand(command, o())).toBe(false)
    })

    it('an empty command does nothing', () => {
      expect(unsafeFilterCommand('', o())).toBe(false)
    })

    it('an absolute path inside the repo, inside a root, or linked into one', () => {
      mkdirSync(join(root, 'links'))
      symlinkSync(R('tool.sh'), join(root, 'links', 'tool'))
      writeFileSync(R('tool.sh'), 'x')
      writeFileSync(R('git-lfs'), 'x')
      for (const c of [R('tool.sh'), R('git-lfs'), join(root, 'w', 'git-lfs'), join(root, 'links', 'tool'), `git-lfs ${R('tool.sh')}`, `git-lfs --from=${R('tool.sh')}`]) {
        expect(unsafeFilterCommand(c, o())).toBe(true)
      }
    })

    it('a bare word that names a file in the tree is a path', () => {
      writeFileSync(R('rules'), 'x')
      expect(unsafeFilterCommand('git-crypt -f rules', o())).toBe(true)
      expect(unsafeFilterCommand('git-crypt -f other', o())).toBe(false)
    })

    it('a bare program is resolved on PATH: inside a writable root it is refused, a relative PATH entry too', () => {
      const dir = join(root, 'w', 'bin')
      const safe = join(root, 'safe')
      for (const d of [dir, safe]) {
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, 'git-lfs'), '#!/bin/sh\n')
        chmodSync(join(d, 'git-lfs'), 0o755)
      }
      expect(unsafeFilterCommand('git-lfs clean', { ...o(), path: `/usr/bin:${dir}` })).toBe(true)
      expect(unsafeFilterCommand('git-lfs clean', { ...o(), path: `.:${safe}` })).toBe(true)
      expect(unsafeFilterCommand('git-lfs clean', { ...o(), path: `:${safe}` })).toBe(true)
      // 前面的条目先找到:后面那个可写目录轮不到
      expect(unsafeFilterCommand('git-lfs clean', { ...o(), path: `${safe}:${dir}` })).toBe(false)
      // 哪里都没有:什么也跑不起来
      expect(unsafeFilterCommand('git-lfs clean', { ...o(), path: '/nonexistent' })).toBe(false)
    })
  })
})

describe('refExists', () => {
  it('goes through the guarded wrapper, and answers yes or no', async () => {
    initRepo()
    write(R('a.txt'), 'a\n')
    ug(['add', 'a.txt'])
    commit('init')
    const calls: string[][] = []
    const real = createGit({ base: base(), extraEnv: injected() })
    const g: Git = (args, o) => (calls.push(args), real(args, o))
    await takeSnapshot(repo, 'refs/mffai/x/there', real, { tmpDir: tmp })
    expect(await refExists(repo, 'refs/mffai/x/there', g, { tmpDir: tmp })).toBe(true)
    expect(await refExists(repo, 'refs/mffai/x/gone', g, { tmpDir: tmp })).toBe(false)
    expect(calls.every(a => a.some(x => x.startsWith('core.hooksPath=')))).toBe(true)
  })
})

describe('fileDiff (08 §4.4)', () => {
  const fileDiff = async (from: string, to: string, p: string, g: Git = git(), o: { maxLines?: number; maxBytes?: number } = {}) =>
    git_.fileDiff(repo, from, to, p, g, { pin: await pinRepo(repo, g), tmpDir: tmp, ...o })
  const head = () => ug(['rev-parse', 'HEAD']).trim()
  /** 和 app 的 parseUnifiedDiff 一样的规则 */
  const expected = (from: string, to: string, p: string) => {
    const res: { kind: string; ln: number; text: string }[] = []
    let oldLn = 0
    let newLn = 0
    let inHunk = false
    for (const l of ug(['diff', '-U3', '--no-color', from, to, '--', p]).split('\n')) {
      if (l.startsWith('@@')) {
        const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)!
        oldLn = Number(m[1])
        newLn = Number(m[2])
        inHunk = true
        continue
      }
      if (!inHunk || l.startsWith('+++') || l.startsWith('---') || l.startsWith('\\') || l === '') continue
      if (l.startsWith('+')) res.push({ kind: 'add', ln: newLn++, text: l.slice(1) })
      else if (l.startsWith('-')) res.push({ kind: 'del', ln: oldLn++, text: l.slice(1) })
      else res.push({ kind: 'ctx', ln: newLn++, text: l.slice(1) }), oldLn++
    }
    return res
  }

  it('add, del and ctx line numbers match git diff -U3; status from the trees', async () => {
    initRepo()
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
    write(R('f.txt'), lines.join('\n') + '\n')
    write(R('gone.txt'), 'bye\n')
    ug(['add', '-A'])
    commit('one')
    const a = head()
    const edited = [...lines]
    edited.splice(3, 1, 'changed 4')
    edited.splice(20, 0, 'inserted')
    edited.splice(35, 2)
    write(R('f.txt'), edited.join('\n') + '\n')
    write(R('new.txt'), 'n1\nn2\n')
    rmSync(R('gone.txt'))
    ug(['add', '-A'])
    commit('two')
    const b = head()
    const d = await fileDiff(a, b, 'f.txt')
    expect(d).toMatchObject({ path: 'f.txt', status: 'M', binary: false, truncated: false })
    expect(d.lines).toEqual(expected(a, b, 'f.txt'))
    expect(d.lines.filter(l => l.kind === 'add').map(l => l.ln)).toEqual([4, 21])
    expect(await fileDiff(a, b, 'new.txt')).toEqual({ path: 'new.txt', status: 'A', binary: false, truncated: false, lines: [{ kind: 'add', ln: 1, text: 'n1' }, { kind: 'add', ln: 2, text: 'n2' }] })
    expect(await fileDiff(a, b, 'gone.txt')).toEqual({ path: 'gone.txt', status: 'D', binary: false, truncated: false, lines: [{ kind: 'del', ln: 1, text: 'bye' }] })
  })

  it('a binary file: binary, no lines', async () => {
    initRepo()
    write(R('x.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    ug(['add', '-A'])
    commit('one')
    const a = head()
    write(R('x.bin'), Buffer.from([0, 9, 9, 9, 0, 255]))
    ug(['add', '-A'])
    commit('two')
    expect(await fileDiff(a, head(), 'x.bin')).toEqual({ path: 'x.bin', status: 'M', binary: true, truncated: false, lines: [] })
  })

  it('cut at 2000 lines, and at 256 KB', async () => {
    initRepo()
    write(R('keep.txt'), 'k\n')
    ug(['add', '-A'])
    commit('one')
    const a = head()
    write(R('long.txt'), Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n') + '\n')
    write(R('wide.txt'), Array.from({ length: 200 }, () => 'w'.repeat(4000)).join('\n') + '\n')
    ug(['add', '-A'])
    commit('two')
    const long = await fileDiff(a, head(), 'long.txt')
    expect(long.truncated).toBe(true)
    expect(long.lines).toHaveLength(2000)
    expect(long.lines.at(-1)).toEqual({ kind: 'add', ln: 2000, text: 'l1999' })
    const wide = await fileDiff(a, head(), 'wide.txt')
    expect(wide.truncated).toBe(true)
    const bytes = wide.lines.reduce((n, l) => n + Buffer.byteLength(l.text), 0)
    expect(bytes).toBeLessThanOrEqual(262144)
    expect(bytes).toBeGreaterThan(262144 - 8000)
    const small = await fileDiff(a, head(), 'long.txt', git(), { maxLines: 10 })
    expect(small.lines).toHaveLength(10)
  })

  it('the external diff and the textconv the repo configures never run', async () => {
    initRepo()
    const mark = join(root, 'ran')
    write(join(root, 'tool.sh'), `#!/bin/sh\ntouch "${mark}"\necho FROMTOOL\n`)
    chmodSync(join(root, 'tool.sh'), 0o755)
    write(R('.gitattributes'), '*.txt diff=tc\n')
    write(R('f.txt'), 'one\n')
    ug(['add', '-A'])
    commit('one')
    const a = head()
    ug(['config', 'diff.external', join(root, 'tool.sh')])
    ug(['config', 'diff.tc.textconv', join(root, 'tool.sh')])
    ug(['config', 'diff.tc.command', join(root, 'tool.sh')])
    write(R('f.txt'), 'two\n')
    ug(['add', '-A'])
    commit('two')
    const d = await fileDiff(a, head(), 'f.txt')
    expect(d.lines).toEqual([{ kind: 'del', ln: 1, text: 'one' }, { kind: 'add', ln: 1, text: 'two' }])
    expect(existsSync(mark)).toBe(false)
  })

  it('a filter the sandbox could rewrite: refused like changes, and it never runs', async () => {
    initRepo()
    const mark = join(root, 'ran')
    write(R('f.txt'), 'one\n')
    ug(['add', '-A'])
    commit('one')
    const a = head()
    write(R('f.txt'), 'two\n')
    ug(['add', '-A'])
    commit('two')
    write(R('tool.sh'), `#!/bin/sh\ntouch "${mark}"\ncat\n`)
    chmodSync(R('tool.sh'), 0o755)
    write(R('.gitattributes'), '*.txt filter=f\n')
    ug(['config', 'filter.f.clean', './tool.sh'])
    ug(['config', 'filter.f.smudge', './tool.sh'])
    await expect(fileDiff(a, head(), 'f.txt')).rejects.toThrow(/unsafe_filter/)
    expect(existsSync(mark)).toBe(false)
  })

  it('a path with glob characters is literal, and a path outside the cwd prefix is not read', async () => {
    initRepo()
    write(R('a*.txt'), 'star\n')
    write(R('ab.txt'), 'ab\n')
    write(R('sub/s.txt'), 's\n')
    ug(['add', '-A'])
    commit('one')
    const a = head()
    write(R('a*.txt'), 'star2\n')
    write(R('ab.txt'), 'ab2\n')
    write(R('sub/s.txt'), 's2\n')
    ug(['add', '-A'])
    commit('two')
    const d = await fileDiff(a, head(), 'a*.txt')
    expect(d.lines.map(l => l.text)).toEqual(['star', 'star2'])
    const g = git()
    await expect(git_.fileDiff(join(repo, 'sub'), a, head(), 'ab.txt', g, { pin: await pinRepo(repo, g), tmpDir: tmp })).rejects.toThrow(/not changed/)
  })
})
