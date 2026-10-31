import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changes, createGit, gitEnv, pruneRefs, repoInfo, restore, takeSnapshot, type Git } from './snapshot'

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

describe('repoInfo', () => {
  it('reports top, prefix, gitDir and HEAD', async () => {
    initRepo()
    write(R('sub/x.txt'), 'x')
    ug(['add', '.'])
    commit('init')
    const head = ug(['rev-parse', 'HEAD']).trim()
    expect(await repoInfo(R('sub'), git())).toEqual({ top: repo, prefix: 'sub/', gitDir: join(repo, '.git'), head })
    expect(await repoInfo(repo, git())).toMatchObject({ prefix: '', head })
  })

  it('is undefined outside a repo', async () => {
    expect(await repoInfo(tmp, git())).toBeUndefined()
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
    expect(await takeSnapshot(repo, 'refs/mffai/snapshots/s/t-start', g, { tmpDir: tmp })).toEqual({ reason: 'error' })
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
    ug(['config', 'filter.rot.clean', 'tr a-zA-Z n-za-mN-ZA-M'])
    ug(['config', 'filter.rot.smudge', 'tr a-zA-Z n-za-mN-ZA-M'])
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
