// worktree 的增删(04 Task 9):夹具是真 git,钩子和 fsmonitor 留标记文件看跑没跑
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGit, takeSnapshot, type Git } from './snapshot'
import { addWorktree, MAX_WORKTREES, removeInWorktree, removeWorktree, reserveWorktree, rootConflict, sessionRepo, userGitState, worktreeIntact } from './worktree'

let base: string
let home: string
let repo: string
let wtRoot: string
let tmp: string
let git: Git
let start: string

const env = () => ({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
const ug = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env: env() }).toString()
const worktrees = () => ug(['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length))
const o = () => ({ root: wtRoot, tmpDir: tmp })

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-wt-test-')))
  home = join(base, 'home')
  repo = join(base, 'repo')
  wtRoot = join(base, 'wt')
  tmp = join(base, 'tmp')
  for (const d of [home, repo, tmp]) mkdirSync(d)
  writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[commit]\n\tgpgSign = false\n')
  ug(['init', '-q'])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  ug(['add', '-A'])
  ug(['commit', '-qm', 'init'])
  git = createGit({ base: env() })
  const snap = await takeSnapshot(repo, 'refs/mffai/runs/s1/r-start', git, { tmpDir: tmp })
  start = snap.ref!
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('addWorktree', () => {
  it('checks out the commit detached, and a user hook and fsmonitor do not run', async () => {
    const mark = join(base, 'ran')
    const script = join(base, 'probe.sh')
    writeFileSync(script, `#!/bin/sh\necho "$0" >> ${JSON.stringify(mark)}\n`)
    chmodSync(script, 0o755)
    for (const hook of ['post-checkout', 'reference-transaction', 'post-index-change']) {
      writeFileSync(join(repo, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(mark)}\n`)
      chmodSync(join(repo, '.git', 'hooks', hook), 0o755)
    }
    ug(['config', 'core.fsmonitor', script])
    const path = join(wtRoot, 's1', 'r')
    mkdirSync(path, { recursive: true })
    await addWorktree(repo, path, start, git, o())
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n')
    expect(worktrees()).toContain(path)
    expect(ug(['rev-parse', 'HEAD'], path).trim()).toBe(ug(['rev-parse', start]).trim())
    expect(() => ug(['symbolic-ref', '-q', 'HEAD'], path)).toThrow()
    expect(existsSync(mark)).toBe(false)
  })

  it('leaves the user\'s index, HEAD, branch and stash byte-identical', async () => {
    writeFileSync(join(repo, 'a.txt'), 'stashed\n')
    ug(['stash', 'push', '-q', '-m', 'mine'])
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    ug(['add', 'a.txt'])
    const files = ['index', 'HEAD', 'refs/stash', 'logs/refs/stash', 'logs/HEAD', ...readdirSync(join(repo, '.git', 'refs', 'heads')).map(b => `refs/heads/${b}`)]
    const read = () => files.map(f => readFileSync(join(repo, '.git', f)).toString('hex'))
    const before = read()
    const topBefore = readdirSync(join(repo, '.git')).sort()
    const path = join(wtRoot, 's1', 'r')
    mkdirSync(path, { recursive: true })
    await addWorktree(repo, path, start, git, o())
    expect(read()).toEqual(before)
    expect(readdirSync(join(repo, '.git')).filter(n => !topBefore.includes(n))).toEqual(['worktrees'])
    expect(readdirSync(join(repo, '.git', 'worktrees'))).toEqual(['r'])
    await removeWorktree(repo, path, git, o())
    expect(read()).toEqual(before)
  })

  it('a git failure rejects', async () => {
    const path = join(wtRoot, 's1', 'r')
    await expect(addWorktree(repo, path, 'refs/mffai/no-such', git, o())).rejects.toThrow()
    await expect(addWorktree(join(base, 'tmp'), path, start, git, o())).rejects.toThrow()
  })

  it('a commit that looks like an option is refused, git never asked', async () => {
    const calls: string[][] = []
    const spy: Git = (args, opts) => (calls.push(args), git(args, opts))
    await expect(addWorktree(repo, join(wtRoot, 's1', 'r'), '--orphan', spy, o())).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('the path has to be under the root', () => {
  const spy = () => {
    const calls: string[][] = []
    const g: Git = (args, opts) => (calls.push(args), git(args, opts))
    return { g, calls }
  }

  it.each([
    ['traversal', () => join(wtRoot, 's1') + '/../../escape'],
    ['the root itself', () => wtRoot],
    ['a session directory: would take every worktree in it', () => join(wtRoot, 's1')],
    ['deeper than a run', () => join(wtRoot, 's1', 'r', 'deep')],
    ['a sibling sharing the prefix', () => `${wtRoot}-other/s1/r`],
    ['elsewhere', () => join(base, 'repo')],
    ['relative', () => '../escape'],
  ])('%s is rejected by both, with no git call', async (_name, path) => {
    const { g, calls } = spy()
    await expect(addWorktree(repo, path(), start, g, o())).rejects.toThrow(/root/)
    await expect(removeWorktree(repo, path(), g, o())).rejects.toThrow(/root/)
    expect(calls).toEqual([])
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  })

  it('a link under the root pointing out is rejected: the real path decides', async () => {
    mkdirSync(wtRoot)
    mkdirSync(join(base, 'outside'))
    writeFileSync(join(base, 'outside', 'keep'), 'keep')
    symlinkSync(join(base, 'outside'), join(wtRoot, 'link'))
    const { g, calls } = spy()
    await expect(removeWorktree(repo, join(wtRoot, 'link'), g, o())).rejects.toThrow(/root/)
    await expect(addWorktree(repo, join(wtRoot, 'link', 'r'), start, g, o())).rejects.toThrow(/root/)
    expect(calls).toEqual([])
    expect(existsSync(join(base, 'outside', 'keep'))).toBe(true)
  })
})

describe('removeWorktree', () => {
  const added = async (name = 'r') => {
    const path = join(wtRoot, 's1', name)
    mkdirSync(path, { recursive: true })
    await addWorktree(repo, path, start, git, o())
    return path
  }

  it('removes a dirty worktree and its entry', async () => {
    const path = await added()
    writeFileSync(join(path, 'a.txt'), 'changed\n')
    writeFileSync(join(path, 'new.txt'), 'new\n')
    await removeWorktree(repo, path, git, o())
    expect(existsSync(path)).toBe(false)
    expect(worktrees()).toEqual([repo])
    expect(existsSync(join(repo, '.git', 'worktrees', 'r'))).toBe(false)
  })

  it('a locked worktree still goes: it is ours, and the person asked', async () => {
    const path = await added()
    ug(['worktree', 'lock', path])
    await removeWorktree(repo, path, git, o())
    expect(existsSync(path)).toBe(false)
    expect(worktrees()).toEqual([repo])
  })

  it('a tampered .git: git refuses, the directory goes anyway, and the entry is pruned', async () => {
    const path = await added()
    writeFileSync(join(path, '.git'), 'gitdir: /nonexistent\n')
    await removeWorktree(repo, path, git, o())
    expect(existsSync(path)).toBe(false)
    expect(worktrees()).toEqual([repo])
  })

  it('the repo is gone: the directory still goes', async () => {
    const path = await added()
    rmSync(repo, { recursive: true, force: true })
    await removeWorktree(repo, path, git, o())
    expect(existsSync(path)).toBe(false)
  })

  it('a user\'s own entry whose path is missing survives: only ours goes', async () => {
    const external = join(base, 'external-drive')
    ug(['worktree', 'add', '-q', '--detach', external])
    rmSync(external, { recursive: true, force: true }) // 移动硬盘没插
    const path = await added()
    await removeWorktree(repo, path, git, o())
    expect(readdirSync(join(repo, '.git', 'worktrees'))).toEqual(['external-drive'])
    expect(worktrees()).toContain(external)
  })

  it('never runs a global prune, on the fallback path either', async () => {
    const calls: string[][] = []
    const spy: Git = (args, opts) => (calls.push(args), git(args, opts))
    const external = join(base, 'external-drive')
    ug(['worktree', 'add', '-q', '--detach', external])
    rmSync(external, { recursive: true, force: true })
    const path = await added()
    writeFileSync(join(path, '.git'), 'gitdir: /nonexistent\n')
    await removeWorktree(repo, path, spy, o())
    expect(calls.some(a => a.includes('prune'))).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(join(repo, '.git', 'worktrees'))).toEqual(['external-drive'])
  })

  it('a directory someone already deleted: the entry is pruned, no throw', async () => {
    const path = await added()
    rmSync(path, { recursive: true, force: true })
    await removeWorktree(repo, path, git, o())
    expect(worktrees()).toEqual([repo])
  })
})

describe('reserveWorktree', () => {
  it('makes <root>/<session>/<run> at 0700 under the real root', () => {
    const path = reserveWorktree(wtRoot, 's1', 'r1')!
    expect(path).toBe(join(realpathSync(wtRoot), 's1', 'r1'))
    expect(existsSync(path)).toBe(true)
    expect(execFileSync('/bin/ls', ['-ld', wtRoot]).toString().startsWith('drwx------')).toBe(true)
  })

  it('resolves a linked root, so the CLI cwd matches what the sandbox sees', () => {
    mkdirSync(join(base, 'real-root'))
    symlinkSync(join(base, 'real-root'), wtRoot)
    expect(reserveWorktree(wtRoot, 's1', 'r1')).toBe(join(base, 'real-root', 's1', 'r1'))
  })

  it(`the limit is ${MAX_WORKTREES} across sessions; a file does not count; a free slot works again`, () => {
    expect(MAX_WORKTREES).toBe(20)
    for (let i = 0; i < 19; i++) expect(reserveWorktree(wtRoot, i % 2 ? 's1' : 's2', `r${i}`)).toBeDefined()
    writeFileSync(join(wtRoot, '.DS_Store'), 'x')
    writeFileSync(join(wtRoot, 's1', '.DS_Store'), 'x')
    expect(reserveWorktree(wtRoot, 's3', 'r19')).toBeDefined()
    expect(reserveWorktree(wtRoot, 's3', 'r20')).toBeUndefined()
    expect(existsSync(join(wtRoot, 's3', 'r20'))).toBe(false)
    rmSync(join(wtRoot, 's1', 'r1'), { recursive: true })
    expect(reserveWorktree(wtRoot, 's3', 'r20')).toBeDefined()
  })

  it('an id that climbs out is refused, nothing made', () => {
    expect(() => reserveWorktree(wtRoot, '..', 'escape')).toThrow(/root/)
    expect(() => reserveWorktree(wtRoot, 's1', '../../escape')).toThrow(/root/)
    expect(existsSync(join(base, 'escape'))).toBe(false)
  })

  it('a reservation that already exists throws: it is not ours to reuse', () => {
    reserveWorktree(wtRoot, 's1', 'r1')
    expect(() => reserveWorktree(wtRoot, 's1', 'r1')).toThrow()
  })
})

describe('sessionRepo and userGitState', () => {
  it('a plain repo at the top and in a subdirectory', async () => {
    mkdirSync(join(repo, 'sub'))
    expect(await sessionRepo(repo, git, { tmpDir: tmp })).toMatchObject({ top: repo, prefix: '', gitDir: join(repo, '.git'), commonDir: join(repo, '.git') })
    expect(await sessionRepo(join(repo, 'sub'), git, { tmpDir: tmp })).toMatchObject({ top: repo, prefix: 'sub/' })
  })

  it('not a repo → undefined', async () => {
    expect(await sessionRepo(tmp, git, { tmpDir: tmp })).toBeUndefined()
  })

  it('a session that is itself a linked worktree: the common dir and its own git dir are both protected', async () => {
    const linked = join(base, 'linked')
    ug(['worktree', 'add', '-q', '--detach', linked])
    const info = (await sessionRepo(linked, git, { tmpDir: tmp }))!
    expect(info.commonDir).toBe(join(repo, '.git'))
    expect(info.gitDir).toBe(join(repo, '.git', 'worktrees', 'linked'))
    const state = userGitState(info)
    expect(state).toEqual([join(repo, '.git'), join(repo, '.git', 'worktrees', 'linked')])
  })

  it('a plain repo: the whole common dir is read-only', async () => {
    expect(userGitState((await sessionRepo(repo, git, { tmpDir: tmp }))!)).toEqual([join(repo, '.git')])
  })
})

describe('worktreeIntact', () => {
  const added = async () => {
    const path = join(wtRoot, 's1', 'r')
    mkdirSync(path, { recursive: true })
    await addWorktree(repo, path, start, git, o())
    return path
  }
  const check = (path: string, cwd = path) => worktreeIntact(repo, path, cwd, git, { tmpDir: tmp })

  it('a fresh worktree is intact, also from a subdirectory', async () => {
    const path = await added()
    mkdirSync(join(path, 'sub'))
    expect(await check(path)).toBe(true)
    expect(await check(path, join(path, 'sub'))).toBe(true)
  })

  it('relative paths in .git (worktree.useRelativePaths) are still intact', async () => {
    ug(['config', 'worktree.useRelativePaths', 'true'])
    const path = await added()
    expect(await check(path)).toBe(true)
  })

  it('.git pointing elsewhere → not intact', async () => {
    const path = await added()
    const evil = join(base, 'evil')
    cpSync(join(repo, '.git'), evil, { recursive: true })
    writeFileSync(join(path, '.git'), `gitdir: ${evil}\n`)
    expect(await check(path)).toBe(false)
  })

  it('.git pointing at another worktree of the same repo → not intact', async () => {
    const path = await added()
    const other = join(wtRoot, 's1', 'other')
    mkdirSync(other)
    await addWorktree(repo, other, start, git, o())
    writeFileSync(join(path, '.git'), readFileSync(join(other, '.git')))
    expect(await check(path)).toBe(false)
  })

  it('.git replaced by a directory, or a link → not intact', async () => {
    const path = await added()
    const saved = readFileSync(join(path, '.git'))
    rmSync(join(path, '.git'))
    mkdirSync(join(path, '.git'))
    expect(await check(path)).toBe(false)
    rmSync(join(path, '.git'), { recursive: true })
    symlinkSync(join(repo, '.git'), join(path, '.git'))
    expect(await check(path)).toBe(false)
    rmSync(join(path, '.git'))
    writeFileSync(join(path, '.git'), saved)
    expect(await check(path)).toBe(true)
  })

  it('a .git planted between the top and the run cwd → not intact: git would stop there', async () => {
    const path = await added()
    mkdirSync(join(path, 'sub', 'deep'), { recursive: true })
    mkdirSync(join(path, 'sub', '.git'))
    expect(await check(path, join(path, 'sub', 'deep'))).toBe(false)
  })

  it('an admin dir outside this repo, however well forged → not intact', async () => {
    const path = await added()
    const forged = join(base, 'forged')
    mkdirSync(forged)
    writeFileSync(join(forged, 'gitdir'), `${join(path, '.git')}\n`)
    writeFileSync(join(forged, 'commondir'), `${join(repo, '.git')}\n`)
    writeFileSync(join(path, '.git'), `gitdir: ${forged}\n`)
    expect(await check(path)).toBe(false)
  })

  it('commondir pointing elsewhere → not intact', async () => {
    const path = await added()
    expect(await check(path)).toBe(true)
    writeFileSync(join(repo, '.git', 'worktrees', 'r', 'commondir'), `${join(base, 'evil')}\n`)
    mkdirSync(join(base, 'evil'))
    expect(await check(path)).toBe(false)
  })

  it('gone, or not a repo → not intact, no throw', async () => {
    const path = await added()
    expect(await worktreeIntact(tmp, path, path, git, { tmpDir: tmp })).toBe(false)
    rmSync(path, { recursive: true, force: true })
    expect(await check(path)).toBe(false)
  })
})

describe('rootConflict', () => {
  const info = async (cwd = repo) => (await sessionRepo(cwd, git, { tmpDir: tmp }))!

  it('a root beside the repo is fine, existing or not', async () => {
    expect(rootConflict(wtRoot, await info(), repo)).toBe(false)
    mkdirSync(wtRoot)
    expect(rootConflict(wtRoot, await info(), repo)).toBe(false)
  })

  it('inside the repo, inside its git dir, or the repo itself', async () => {
    expect(rootConflict(join(repo, '.wt'), await info(), repo)).toBe(true)
    expect(rootConflict(join(repo, '.git', 'wt'), await info(), repo)).toBe(true)
    expect(rootConflict(repo, await info(), repo)).toBe(true)
  })

  it('linked into the repo: the real path decides', async () => {
    mkdirSync(join(repo, 'real'))
    symlinkSync(join(repo, 'real'), wtRoot)
    expect(rootConflict(wtRoot, await info(), repo)).toBe(true)
  })

  it('a session running inside the root', async () => {
    mkdirSync(wtRoot)
    const inner = join(wtRoot, 'repo')
    mkdirSync(inner)
    ug(['init', '-q'], inner)
    expect(rootConflict(wtRoot, await info(inner), inner)).toBe(true)
  })

  it('a linked-worktree session: the common dir of the main repo counts', async () => {
    const linked = join(base, 'linked')
    ug(['worktree', 'add', '-q', '--detach', linked])
    expect(rootConflict(join(repo, '.git', 'wt'), await info(linked), linked)).toBe(true)
  })
})

describe('removeInWorktree', () => {
  const tree = () => {
    const path = join(wtRoot, 's1', 'r')
    mkdirSync(join(path, 'hidden', 'deep'), { recursive: true })
    writeFileSync(join(path, 'hidden', 'deep', 'h.txt'), 'h')
    writeFileSync(join(path, 'keep.txt'), 'k')
    return path
  }

  it('removes a directory or a file under the worktree, keeps the rest; a missing root is no failure', () => {
    const path = tree()
    writeFileSync(join(path, 'one.txt'), 'o')
    expect(removeInWorktree(path, [join(path, 'hidden'), join(path, 'one.txt'), join(path, 'nope', 'x')])).toEqual([])
    expect(existsSync(join(path, 'hidden'))).toBe(false)
    expect(existsSync(join(path, 'one.txt'))).toBe(false)
    expect(existsSync(join(path, 'keep.txt'))).toBe(true)
  })

  it('roots that are not strictly inside are ignored: the worktree itself, the session\'s copy', () => {
    const path = tree()
    writeFileSync(join(repo, 'hidden.txt'), 'session')
    expect(removeInWorktree(path, [path, join(repo, 'hidden.txt'), wtRoot])).toEqual([])
    expect(existsSync(join(path, 'keep.txt'))).toBe(true)
    expect(existsSync(join(repo, 'hidden.txt'))).toBe(true)
  })

  it('a link planted on the way is not followed out of the worktree, and is reported', () => {
    const path = tree()
    const outside = join(base, 'outside')
    mkdirSync(join(outside, 'secret'), { recursive: true })
    writeFileSync(join(outside, 'secret', 'keep'), 'keep')
    symlinkSync(outside, join(path, 'a'))
    expect(removeInWorktree(path, [join(path, 'a', 'secret')])).toEqual([join(path, 'a', 'secret')])
    expect(existsSync(join(outside, 'secret', 'keep'))).toBe(true)
  })

  it('a root that is itself a link: the link goes, not what it points at', () => {
    const path = tree()
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'keep')
    symlinkSync(outside, join(path, 'linked'))
    expect(removeInWorktree(path, [join(path, 'linked')])).toEqual([])
    expect(existsSync(join(path, 'linked'))).toBe(false)
    expect(existsSync(join(outside, 'keep'))).toBe(true)
  })
})
