// IM 会话的 worktree(07 spec §8.1):夹具是真 git。过滤器和钩子留标记文件看跑没跑
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changes, createGit, pinRepo, restore, takeSnapshot, type Git, type PinnedRepo } from './snapshot'
import { createImWorktree, imWorktreeRootOf, isImCwd, removeImWorktree } from './imWorktree'
import { MAX_WORKTREES, reserveWorktree } from './worktree'

let base: string
let home: string
let repo: string
let dataDir: string
let tmp: string
let git: Git

const env = () => ({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base })
const ug = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env: env(), stdio: ['ignore', 'pipe', 'ignore'] }).toString()
const worktrees = (cwd = repo) => ug(['worktree', 'list', '--porcelain'], cwd).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length))
const imRoot = () => imWorktreeRootOf(dataDir)
const pathOf = (group = 'c1', id = 'wt_1') => join(imRoot(), group, id)
const create = (over: Partial<Parameters<typeof createImWorktree>[0]> = {}) =>
  createImWorktree({ dataDir, project: repo, group: 'c1', id: 'wt_1', git, tmpDir: tmp, untrusted: [dataDir], writableRoots: [], denyReadOf: () => [], ...over })
const nothingLeft = () => {
  expect(existsSync(imRoot())).toBe(false)
  expect(worktrees()).toEqual([repo])
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-imwt-')))
  home = join(base, 'home')
  repo = join(base, 'repo')
  dataDir = join(base, 'data')
  tmp = join(base, 'tmp')
  for (const d of [home, repo, tmp, dataDir]) mkdirSync(d)
  writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[commit]\n\tgpgSign = false\n')
  ug(['init', '-q'])
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'sub', 'b.txt'), 'b\n')
  ug(['add', '-A'])
  ug(['commit', '-qm', 'init'])
  // createGit 去掉 base 里的 GIT_*:全局配置要经 extraEnv 给
  git = createGit({ base: { PATH: env().PATH, HOME: home }, extraEnv: { GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base } })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('createImWorktree', () => {
  it('a detached worktree at HEAD; an uncommitted edit and an untracked .env stay out; the user\'s git state is byte-identical', async () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    writeFileSync(join(repo, '.env'), 'TOKEN=1\n')
    const files = ['index', 'HEAD', ...readdirSync(join(repo, '.git', 'refs', 'heads')).map(b => `refs/heads/${b}`)]
    const bytes = () => files.map(f => readFileSync(join(repo, '.git', f)).toString('hex'))
    ug(['add', 'a.txt'])
    const before = bytes()
    const r = await create()
    expect(r).toEqual({ ok: true, id: 'wt_1', path: pathOf(), cwd: pathOf(), top: repo, base: ug(['rev-parse', 'HEAD']).trim() })
    expect(readFileSync(join(pathOf(), 'a.txt'), 'utf8')).toBe('a\n')
    expect(existsSync(join(pathOf(), '.env'))).toBe(false)
    expect(ug(['rev-parse', 'HEAD'], pathOf())).toBe(ug(['rev-parse', 'HEAD']))
    expect(() => ug(['symbolic-ref', '-q', 'HEAD'], pathOf())).toThrow()
    expect(worktrees()).toEqual([repo, pathOf()])
    expect(bytes()).toEqual(before)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('dirty\n')
  })

  it('base is the HEAD it was made from, also when the worktree is reused after HEAD moved (08 §4.5)', async () => {
    const first = ug(['rev-parse', 'HEAD']).trim()
    const r = await create()
    expect(r).toMatchObject({ ok: true, base: first })
    writeFileSync(join(repo, 'a.txt'), 'later\n')
    ug(['commit', '-qam', 'later'])
    // 重投的 /project 认出已建的那个:base 是它自己的 HEAD 不变,不是项目现在的
    ug(['commit', '-q', '--allow-empty', '-m', 'in the worktree'], pathOf())
    const again = await create()
    expect(again).toMatchObject({ ok: true, path: pathOf() })
    expect((again as { base?: string }).base).toBeUndefined()
  })

  it('a project subdirectory: the cwd is the same subdirectory', async () => {
    const r = await create({ project: join(repo, 'sub') })
    expect(r).toMatchObject({ ok: true, path: pathOf(), cwd: join(pathOf(), 'sub') })
    expect(readFileSync(join(pathOf(), 'sub', 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('a project subdirectory that HEAD does not have is created', async () => {
    mkdirSync(join(repo, 'later'))
    const r = await create({ project: join(repo, 'later') })
    expect(r).toMatchObject({ ok: true, cwd: join(pathOf(), 'later') })
    expect(existsSync(join(pathOf(), 'later'))).toBe(true)
  })

  it('a project reached through a symlink resolves to the same repo', async () => {
    symlinkSync(repo, join(base, 'alias'))
    const r = await create({ project: join(base, 'alias', 'sub') })
    expect(r).toMatchObject({ ok: true, cwd: join(pathOf(), 'sub') })
  })

  describe('each error code, nothing left behind', () => {
    it('not_git: a plain directory', async () => {
      const plain = join(base, 'plain')
      mkdirSync(plain)
      expect(await create({ project: plain })).toEqual({ ok: false, error: 'not_git' })
      nothingLeft()
    })

    it('not_git: a repo whose git directory sits in an untrusted place', async () => {
      expect(await create({ untrusted: [join(repo, '.git')] })).toEqual({ ok: false, error: 'not_git' })
      nothingLeft()
    })

    it('no_commits: an empty repo', async () => {
      const empty = join(base, 'empty')
      mkdirSync(empty)
      ug(['init', '-q'], empty)
      expect(await create({ project: empty })).toEqual({ ok: false, error: 'no_commits' })
      expect(existsSync(imRoot())).toBe(false)
    })

    it('root_conflict: the root would land inside the project', async () => {
      const inside = join(repo, '.mffai')
      mkdirSync(inside)
      const r = await create({ dataDir: inside })
      expect(r).toEqual({ ok: false, error: 'root_conflict' })
      expect(existsSync(imWorktreeRootOf(inside))).toBe(false)
      expect(worktrees()).toEqual([repo])
    })

    it('root_conflict: a project inside the root', async () => {
      await create()
      expect(await create({ project: pathOf(), id: 'wt_2' })).toEqual({ ok: false, error: 'root_conflict' })
      expect(worktrees()).toEqual([repo, pathOf()])
    })

    it('unsafe_repo: a smudge filter in the repo config, and the script never ran', async () => {
      const mark = join(base, 'ran')
      writeFileSync(join(repo, 'evil.sh'), `#!/bin/sh\necho x >> ${JSON.stringify(mark)}\ncat\n`)
      chmodSync(join(repo, 'evil.sh'), 0o755)
      writeFileSync(join(repo, '.gitattributes'), '*.txt filter=x\n')
      ug(['config', 'filter.x.smudge', './evil.sh'])
      ug(['config', 'filter.x.clean', 'cat'])
      ug(['add', '.gitattributes', 'evil.sh'])
      ug(['-c', 'filter.x.smudge=cat', 'commit', '-qm', 'attrs'])
      expect(await create()).toEqual({ ok: false, error: 'unsafe_repo' })
      expect(existsSync(mark)).toBe(false)
      nothingLeft()
    })

    it('unsafe_repo: a smudge filter in the global config', async () => {
      writeFileSync(join(home, 'gitconfig'), `${readFileSync(join(home, 'gitconfig'), 'utf8')}[filter "x"]\n\tsmudge = ./evil.sh\n`)
      expect(await create()).toEqual({ ok: false, error: 'unsafe_repo' })
      nothingLeft()
    })

    describe('a filter program in a place the sandbox can write', () => {
      const lfsIn = (dir: string) => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'git-lfs'), '#!/bin/sh\ncat\n')
        chmodSync(join(dir, 'git-lfs'), 0o755)
        ug(['config', 'filter.f.clean', `${join(dir, 'git-lfs')} clean -- %f`])
      }

      it('a root the caller names: unsafe_repo; the same program elsewhere passes, the control', async () => {
        lfsIn(join(base, 'bin'))
        expect(await create({ writableRoots: [join(base, 'bin')] })).toEqual({ ok: false, error: 'unsafe_repo' })
        nothingLeft()
        expect((await create()).ok).toBe(true)
      })

      it('the data directory always counts', async () => {
        lfsIn(join(dataDir, 'bin'))
        expect(await create()).toEqual({ ok: false, error: 'unsafe_repo' })
        nothingLeft()
      })
    })

    it('worktree_limit: the 21st is refused and adds nothing', async () => {
      for (let i = 0; i < MAX_WORKTREES; i++) expect(reserveWorktree(imRoot(), `g${i}`, 'wt')).toBeTruthy()
      expect(await create()).toEqual({ ok: false, error: 'worktree_limit' })
      expect(existsSync(join(imRoot(), 'c1'))).toBe(false)
      expect(worktrees()).toEqual([repo])
    })

    it('worktree_failed: git refuses to add, the reservation is gone', async () => {
      const refusing: Git = async (args, o) => (args.includes('worktree') && args.includes('add') ? { code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: no' } : git(args, o))
      expect(await create({ git: refusing })).toEqual({ ok: false, error: 'worktree_failed' })
      nothingLeft()
    })

    it('worktree_failed: denyReadOf throwing leaves no worktree with the copies still in it', async () => {
      expect(await create({ denyReadOf: () => { throw new Error('no policy') } })).toEqual({ ok: false, error: 'worktree_failed' })
      nothingLeft()
    })

    it('worktree_failed: the subdirectory is a symlink out of the tree in HEAD', async () => {
      const outside = join(base, 'outside')
      mkdirSync(outside)
      rmSync(join(repo, 'sub'), { recursive: true })
      symlinkSync(outside, join(repo, 'sub'))
      ug(['add', '-A'])
      ug(['commit', '-qm', 'link'])
      rmSync(join(repo, 'sub'))
      mkdirSync(join(repo, 'sub'))
      expect(await create({ project: join(repo, 'sub') })).toEqual({ ok: false, error: 'worktree_failed' })
      nothingLeft()
    })

    it('nothing is created through a symlink in HEAD: the deeper directory does not appear outside', async () => {
      const outside = join(base, 'outside')
      mkdirSync(outside)
      rmSync(join(repo, 'sub'), { recursive: true })
      symlinkSync(outside, join(repo, 'sub'))
      ug(['add', '-A'])
      ug(['commit', '-qm', 'link'])
      rmSync(join(repo, 'sub'))
      mkdirSync(join(repo, 'sub', 'deep'), { recursive: true })
      expect(await create({ project: join(repo, 'sub', 'deep') })).toEqual({ ok: false, error: 'worktree_failed' })
      expect(readdirSync(outside)).toEqual([])
      nothingLeft()
    })

    it('a dangling symlink in HEAD: refused, its target is not created', async () => {
      const target = join(base, 'not-yet')
      rmSync(join(repo, 'sub'), { recursive: true })
      symlinkSync(target, join(repo, 'sub'))
      ug(['add', '-A'])
      ug(['commit', '-qm', 'link'])
      rmSync(join(repo, 'sub'))
      mkdirSync(join(repo, 'sub', 'deep'), { recursive: true })
      expect(await create({ project: join(repo, 'sub', 'deep') })).toEqual({ ok: false, error: 'worktree_failed' })
      expect(existsSync(target)).toBe(false)
      nothingLeft()
    })

    it.each([['../escape', 'wt_1'], ['c1', '../../escape'], ['c1/x', 'wt_1'], ['', 'wt_1'], ['c1', '']])('worktree_failed: group %j id %j is not a path segment', async (group, id) => {
      expect(await create({ group, id })).toEqual({ ok: false, error: 'worktree_failed' })
      expect(worktrees()).toEqual([repo])
      expect(existsSync(join(base, 'escape'))).toBe(false)
    })
  })

  describe('a redelivered /project', () => {
    it('the same id returns the same path, adds no worktree, keeps what is in it', async () => {
      const first = await create({ project: join(repo, 'sub') })
      writeFileSync(join(pathOf(), 'work.txt'), 'mine\n')
      const second = await create({ project: join(repo, 'sub') })
      // 08:base 只在新建时给(认出已建的那个时读到的 HEAD 不是它的 base)
      const { base: _base, ...same } = first as Extract<typeof first, { ok: true }>
      expect(second).toEqual(same)
      expect(worktrees()).toEqual([repo, pathOf()])
      expect(readFileSync(join(pathOf(), 'work.txt'), 'utf8')).toBe('mine\n')
    })

    it('holds at the limit too: it is not a new one', async () => {
      await create()
      for (let i = 1; i < MAX_WORKTREES; i++) reserveWorktree(imRoot(), `g${i}`, 'wt')
      expect(await create()).toMatchObject({ ok: true, path: pathOf() })
    })

    it('an empty placeholder left by a crash becomes the worktree', async () => {
      reserveWorktree(imRoot(), 'c1', 'wt_1')
      expect(await create()).toMatchObject({ ok: true, path: pathOf() })
      expect(worktrees()).toEqual([repo, pathOf()])
    })

    it('a symlink the model swapped in before the redelivery: nothing is created through it', async () => {
      await create({ project: join(repo, 'sub') })
      const outside = join(base, 'outside')
      mkdirSync(outside)
      rmSync(join(pathOf(), 'sub'), { recursive: true })
      symlinkSync(outside, join(pathOf(), 'sub'))
      mkdirSync(join(repo, 'sub', 'deep'))
      expect(await create({ project: join(repo, 'sub', 'deep') })).toEqual({ ok: false, error: 'worktree_failed' })
      expect(readdirSync(outside)).toEqual([])
    })

    it('the denied copies are removed again: the crash may have come before they were', async () => {
      await create()
      const copy = join(pathOf(), 'sub')
      expect(existsSync(copy)).toBe(true)
      await create({ denyReadOf: path => [join(path, 'sub')] })
      expect(existsSync(copy)).toBe(false)
    })

    it('a directory that is not this worktree is neither reused nor removed', async () => {
      mkdirSync(pathOf(), { recursive: true })
      writeFileSync(join(pathOf(), 'keep'), 'k')
      expect(await create()).toEqual({ ok: false, error: 'worktree_failed' })
      expect(readFileSync(join(pathOf(), 'keep'), 'utf8')).toBe('k')
      expect(worktrees()).toEqual([repo])
    })

    it('a worktree of another repo at that path is not reused', async () => {
      const other = join(base, 'other')
      mkdirSync(other)
      ug(['init', '-q'], other)
      writeFileSync(join(other, 'o.txt'), 'o\n')
      ug(['add', '-A'], other)
      ug(['commit', '-qm', 'o'], other)
      mkdirSync(join(imRoot(), 'c1'), { recursive: true })
      ug(['worktree', 'add', '-q', '--detach', pathOf(), 'HEAD'], other)
      expect(await create()).toEqual({ ok: false, error: 'worktree_failed' })
      expect(worktrees()).toEqual([repo])
      expect(readFileSync(join(pathOf(), 'o.txt'), 'utf8')).toBe('o\n')
    })

    it('a symlink at that path is not followed', async () => {
      const outside = join(base, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'keep'), 'k')
      mkdirSync(join(imRoot(), 'c1'), { recursive: true })
      symlinkSync(outside, pathOf())
      expect(await create()).toEqual({ ok: false, error: 'worktree_failed' })
      expect(existsSync(join(outside, 'keep'))).toBe(true)
      expect(worktrees()).toEqual([repo])
    })
  })

  describe('deny read copies', () => {
    it('a mapped root is removed; it is told the worktree path and the repo top', async () => {
      const seen: string[][] = []
      const r = await create({ denyReadOf: (path, top) => (seen.push([path, top]), [join(path, 'sub')]) })
      expect(r.ok).toBe(true)
      expect(seen).toEqual([[pathOf(), repo]])
      expect(existsSync(join(pathOf(), 'sub'))).toBe(false)
      expect(existsSync(join(pathOf(), 'a.txt'))).toBe(true)
    })

    it('a root under a symlinked parent is left alone: the link cannot walk the removal out of the tree', async () => {
      const outside = join(base, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret'), 's')
      symlinkSync(outside, join(repo, 'link'))
      ug(['add', '-A'])
      ug(['commit', '-qm', 'link'])
      const r = await create({ denyReadOf: path => [join(path, 'link', 'secret')] })
      expect(r.ok).toBe(true)
      expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('s')
    })

    it('roots outside the worktree are ignored', async () => {
      expect((await create({ denyReadOf: () => [join(repo, 'a.txt')] })).ok).toBe(true)
      expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    })
  })

  it('pinRepo on the worktree is a usable linked pin: snapshot, changes and restore stay in the worktree', async () => {
    const r = await create()
    if (!r.ok) throw new Error(r.error)
    const pin = (await pinRepo(r.cwd, git, { tmpDir: tmp })) as PinnedRepo
    expect(pin).toMatchObject({ kind: 'repo', top: pathOf(), commonDir: join(repo, '.git') })
    expect(pin.gitDir).toBe(join(repo, '.git', 'worktrees', 'wt_1'))
    const start = await takeSnapshot(r.cwd, 'refs/mffai/snapshots/s1/t1-start', git, { pin, tmpDir: tmp })
    expect(start.ref).toBeTruthy()
    writeFileSync(join(r.cwd, 'a.txt'), 'changed\n')
    writeFileSync(join(r.cwd, 'n.txt'), 'new\n')
    const end = await takeSnapshot(r.cwd, 'refs/mffai/snapshots/s1/t1-end', git, { pin, tmpDir: tmp })
    const files = await changes(r.cwd, start.ref!, end.ref!, git, { pin, tmpDir: tmp })
    expect(files.map(f => f.path).sort()).toEqual(['a.txt', 'n.txt'])
    await restore(r.cwd, start.ref!, files, git, { pin, tmpDir: tmp })
    expect(readFileSync(join(r.cwd, 'a.txt'), 'utf8')).toBe('a\n')
    expect(existsSync(join(r.cwd, 'n.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    expect(ug(['status', '--porcelain'])).toBe('')
  })
})

describe('removeImWorktree', () => {
  it('with the project pin: the directory, the git entry and the empty group go', async () => {
    await create()
    const pin = await pinRepo(repo, git, { tmpDir: tmp })
    await removeImWorktree({ dataDir, path: pathOf(), pin, git, tmpDir: tmp })
    expect(existsSync(join(imRoot(), 'c1'))).toBe(false)
    expect(worktrees()).toEqual([repo])
    expect(existsSync(join(repo, '.git', 'worktrees', 'wt_1'))).toBe(false)
  })

  it('with the session\'s linked pin: the git entry goes too', async () => {
    await create()
    const pin = await pinRepo(pathOf(), git, { tmpDir: tmp })
    await removeImWorktree({ dataDir, path: pathOf(), pin, git, tmpDir: tmp })
    expect(existsSync(pathOf())).toBe(false)
    expect(worktrees()).toEqual([repo])
  })

  it('no pin: only the directory', async () => {
    await create()
    await removeImWorktree({ dataDir, path: pathOf(), pin: undefined, git, tmpDir: tmp })
    expect(existsSync(pathOf())).toBe(false)
  })

  it.each([['the root', () => imRoot()], ['a group', () => join(imRoot(), 'c1')], ['the project', () => repo], ['the 04 root', () => join(`${dataDir}-worktrees`, 's', 'r')]])('refuses %s', async (_name, path) => {
    await create()
    await expect(removeImWorktree({ dataDir, path: path(), pin: undefined, git, tmpDir: tmp })).rejects.toThrow(/root/)
    expect(existsSync(pathOf())).toBe(true)
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
  })
})

describe('isImCwd', () => {
  it('a worktree and anything below it count; the root, a group and elsewhere do not', async () => {
    await create({ project: join(repo, 'sub') })
    expect(isImCwd(dataDir, pathOf())).toBe(true)
    expect(isImCwd(dataDir, join(pathOf(), 'sub'))).toBe(true)
    expect(isImCwd(dataDir, imRoot())).toBe(false)
    expect(isImCwd(dataDir, join(imRoot(), 'c1'))).toBe(false)
    expect(isImCwd(dataDir, repo)).toBe(false)
    expect(isImCwd(dataDir, `${imRoot()}-other/c1/wt_1`)).toBe(false)
    expect(isImCwd(dataDir, `${dataDir}-worktrees/s1/run_a`)).toBe(false)
  })

  it('holds with dataDir reached through a symlink, in either direction', async () => {
    await create()
    symlinkSync(base, join(home, 'via'))
    const viaLink = join(home, 'via', 'data')
    expect(isImCwd(viaLink, pathOf())).toBe(true)
    expect(isImCwd(dataDir, join(home, 'via', 'data-im-worktrees', 'c1', 'wt_1'))).toBe(true)
  })

  it('a link out of the root does not count: the real path decides', async () => {
    await create()
    symlinkSync(repo, join(imRoot(), 'c1', 'wt_link'))
    expect(isImCwd(dataDir, join(imRoot(), 'c1', 'wt_link'))).toBe(false)
  })
})
