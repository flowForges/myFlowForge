// 合并 worktree(08 §4.5、评审修订 R4):补丁是不受信的 CLI 写的,要进用户自己的检出。
// 真 git,临时仓库;家目录、全局配置都在临时目录,不读系统配置(同 lib/plugins/fetchGit.ts)
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeInto, type MergeOutcome } from './merge'
import { createGit, pinRepo, takeSnapshot, type Git, type PinnedRepo } from './snapshot'

let root: string
let home: string
let repo: string
let wt: string
let tmp: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-merge-')))
  home = join(root, 'home')
  repo = join(root, 'repo')
  wt = join(root, 'wt')
  tmp = join(root, 'tmp')
  for (const d of [home, repo, tmp]) mkdirSync(d)
  writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = u\n\temail = u@example.invalid\n[commit]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n')
  ug(['init', '-q'])
  w(R('a.txt'), Array.from({ length: 20 }, (_, i) => `a${i}`).join('\n') + '\n')
  w(R('b.txt'), 'b\n')
  w(R('sub/c.txt'), 'c\n')
  ug(['add', '-A'])
  ug(['commit', '-qm', 'init'])
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const injected = () => ({ GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root })
const base = () => ({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home })
const git = (): Git => createGit({ base: base(), extraEnv: injected() })
const ug = (args: string[], cwd = repo, input?: string) => execFileSync('git', args, { cwd, env: { ...base(), ...injected() }, input, maxBuffer: 64 << 20 }).toString()
const w = (p: string, s: string | Buffer) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, s)
}
const R = (p: string) => join(repo, p)
const W = (p: string) => join(wt, p)
const head = () => ug(['rev-parse', 'HEAD']).trim()

/** 检出里每个文件(含链接)的字节、权限,外加用户的索引、HEAD、分支 */
function digest(): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (p === join(repo, '.git')) continue
      const st = lstatSync(p)
      if (st.isDirectory()) {
        out.push(`${p}/`)
        walk(p)
      } else if (st.isSymbolicLink()) out.push(`${p}@`)
      else out.push(`${p}:${(st.mode & 0o777).toString(8)}:${readFileSync(p).toString('hex')}`)
    }
  }
  walk(repo)
  const g = join(repo, '.git')
  for (const f of ['index', 'HEAD', ...readdirSync(join(g, 'refs', 'heads')).map(b => `refs/heads/${b}`)]) if (existsSync(join(g, f))) out.push(`${f}:${readFileSync(join(g, f)).toString('hex')}`)
  return out.sort()
}

interface Case {
  /** 在 worktree 里做的事 */
  edit?: () => void
  /** 直接给结束提交(手工拼的树):CLI 能写出 git add 不肯收的东西 */
  end?: (baseSha: string) => string
  exclude?: () => string[]
  git?: Git
  /** base 用会话目录的快照(含未跟踪的),否则用 HEAD */
  baseSnapshot?: boolean
}

async function prepare(c: Case) {
  const g = git()
  const toPin = (await pinRepo(repo, g)) as PinnedRepo
  let baseRef = head()
  if (c.baseSnapshot) {
    const s = await takeSnapshot(repo, 'refs/mffai/t/start', g, { pin: toPin, tmpDir: tmp })
    expect(s.ref).toBeDefined()
    baseRef = 'refs/mffai/t/start'
  }
  const baseSha = ug(['rev-parse', `${baseRef}^{commit}`]).trim()
  ug(['-c', 'submodule.recurse=false', 'worktree', 'add', '-q', '--detach', wt, baseSha])
  const fromPin = (await pinRepo(wt, g)) as PinnedRepo
  expect(fromPin.kind).toBe('repo')
  let endRef = 'refs/mffai/t/end'
  if (c.end) ug(['update-ref', endRef, c.end(baseSha)])
  else {
    c.edit?.()
    const s = await takeSnapshot(wt, endRef, g, { pin: fromPin, tmpDir: tmp })
    expect(s.ref).toBe(endRef)
  }
  return { fromPin, toPin, baseRef, endRef }
}

async function merge(c: Case, p?: Awaited<ReturnType<typeof prepare>>): Promise<MergeOutcome> {
  const { fromPin, toPin, baseRef, endRef } = p ?? (await prepare(c))
  return mergeInto({ git: c.git ?? git(), from: { pin: fromPin, dir: wt, baseRef, endRef }, to: { pin: toPin, dir: repo }, exclude: c.exclude?.() ?? [], tmpDir: tmp, gitOpts: {} })
}

/** 手工拼一个提交:base 的树再加 entries(mode、内容或 gitlink 的 sha)。mktree 不查路径名,和 CLI 能做到的一样 */
function craft(baseSha: string, entries: { path: string; mode: string; content?: string | Buffer; sha?: string }[]): string {
  type Node = { blobs: Map<string, { mode: string; type: string; sha: string }>; dirs: Map<string, Node> }
  const node = (): Node => ({ blobs: new Map(), dirs: new Map() })
  const top = node()
  const put = (path: string, e: { mode: string; type: string; sha: string }) => {
    const segs = path.split('/')
    let n = top
    for (const s of segs.slice(0, -1)) {
      if (!n.dirs.has(s)) n.dirs.set(s, node())
      n = n.dirs.get(s)!
    }
    n.blobs.set(segs.at(-1)!, e)
  }
  for (const line of ug(['ls-tree', '-r', '-z', baseSha]).split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t')
    const [mode, type, sha] = line.slice(0, tab).split(' ')
    put(line.slice(tab + 1), { mode, type, sha })
  }
  for (const e of entries) {
    if (e.mode === '160000') put(e.path, { mode: e.mode, type: 'commit', sha: e.sha! })
    else {
      const file = join(root, 'blob')
      writeFileSync(file, e.content ?? '')
      put(e.path, { mode: e.mode, type: 'blob', sha: ug(['hash-object', '-w', file]).trim() })
    }
  }
  const mk = (n: Node): string => {
    const lines = [...n.blobs].map(([name, b]) => `${b.mode} ${b.type} ${b.sha}\t${name}`)
    for (const [name, d] of n.dirs) lines.push(`040000 tree ${mk(d)}\t${name}`)
    return ug(['mktree', '-z', '--missing'], repo, lines.map(l => l + '\0').join('')).trim()
  }
  return ug(['commit-tree', '-p', baseSha, '-m', 'crafted', mk(top)]).trim()
}

describe('mergeInto: what goes through', () => {
  it('modified, added and deleted files become uncommitted changes in the checkout; HEAD, index and branch untouched', async () => {
    const before = digest().filter(l => /^(index|HEAD|refs)/.test(l))
    const r = await merge({
      edit: () => {
        w(W('a.txt'), readFileSync(W('a.txt'), 'utf8').replace('a5', 'A5'))
        w(W('new dir/ü n.txt'), 'new\n')
        unlinkSync(W('b.txt'))
      },
    })
    expect(r).toEqual({ ok: true, files: 3 })
    expect(readFileSync(R('a.txt'), 'utf8')).toContain('A5\n')
    expect(readFileSync(R('new dir/ü n.txt'), 'utf8')).toBe('new\n')
    expect(existsSync(R('b.txt'))).toBe(false)
    expect(digest().filter(l => /^(index|HEAD|refs)/.test(l))).toEqual(before)
    expect(ug(['diff', '--cached', '--name-only'])).toBe('')
  })

  it('a binary file added and one modified: byte-exact; a new 100755 file keeps its mode; a mode change goes through', async () => {
    const bin = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256))
    w(R('old.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254]))
    w(R('run.sh'), '#!/bin/sh\n')
    ug(['add', '-A'])
    ug(['commit', '-qm', 'bin'])
    const r = await merge({
      edit: () => {
        w(W('new.bin'), bin)
        w(W('old.bin'), Buffer.from([9, 0, 9, 0, 9]))
        w(W('tool.sh'), '#!/bin/sh\necho t\n')
        chmodSync(W('tool.sh'), 0o755)
        chmodSync(W('run.sh'), 0o755)
      },
    })
    expect(r).toEqual({ ok: true, files: 4 })
    expect(readFileSync(R('new.bin')).equals(bin)).toBe(true)
    expect(readFileSync(R('old.bin')).equals(Buffer.from([9, 0, 9, 0, 9]))).toBe(true)
    expect(statSync(R('tool.sh')).mode & 0o111).not.toBe(0)
    expect(statSync(R('run.sh')).mode & 0o111).not.toBe(0)
  })

  it('a deny-read copy the worktree deleted (.env.local): left in the checkout, not counted', async () => {
    w(R('.env.local'), 'TOKEN=1\n')
    const r = await merge({
      baseSnapshot: true,
      edit: () => {
        unlinkSync(W('.env.local'))
        w(W('n.txt'), 'n\n')
      },
      exclude: () => [W('.env.local')],
    })
    expect(r).toEqual({ ok: true, files: 1 })
    expect(readFileSync(R('.env.local'), 'utf8')).toBe('TOKEN=1\n')
    expect(readFileSync(R('n.txt'), 'utf8')).toBe('n\n')
  })

  it('a deny-read directory the worktree deleted, tracked: left in place', async () => {
    w(R('hidden/h.txt'), 'h\n')
    ug(['add', '-A'])
    ug(['commit', '-qm', 'hidden'])
    const r = await merge({ edit: () => rmSync(W('hidden'), { recursive: true }), exclude: () => [W('hidden')] })
    expect(r).toEqual({ ok: false, reason: 'nothing' })
    expect(readFileSync(R('hidden/h.txt'), 'utf8')).toBe('h\n')
  })

  it('no changes: nothing', async () => {
    const before = digest()
    expect(await merge({})).toEqual({ ok: false, reason: 'nothing' })
    expect(digest()).toEqual(before)
  })

  it('only the run cwd prefix is merged', async () => {
    const g = git()
    const p = await prepare({
      edit: () => {
        w(W('sub/c.txt'), 'c2\n')
        w(W('b.txt'), 'b2\n')
      },
    })
    const r = await mergeInto({ git: g, from: { pin: p.fromPin, dir: W('sub'), baseRef: p.baseRef, endRef: p.endRef }, to: { pin: p.toPin, dir: repo }, exclude: [], tmpDir: tmp, gitOpts: {} })
    expect(r).toEqual({ ok: true, files: 1 })
    expect(readFileSync(R('sub/c.txt'), 'utf8')).toBe('c2\n')
    expect(readFileSync(R('b.txt'), 'utf8')).toBe('b\n')
  })

  it('the git calls: --binary --full-index --no-renames for the patch; apply with protectHFS/NTFS and none of --unsafe-paths, --index, --3way, --reject', async () => {
    const calls: string[][] = []
    const real = git()
    const spy: Git = (args, o) => {
      calls.push(args)
      return real(args, o)
    }
    expect(await merge({ edit: () => w(W('n.txt'), 'n\n'), git: spy })).toEqual({ ok: true, files: 1 })
    const patch = calls.find(a => a.includes('diff') && a.includes('--binary'))!
    expect(patch).toEqual(expect.arrayContaining(['--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv']))
    const applies = calls.filter(a => a.includes('apply'))
    expect(applies).toHaveLength(2)
    for (const a of applies) {
      expect(a).toEqual(expect.arrayContaining(['core.protectHFS=true', 'core.protectNTFS=true']))
      expect(a.some(x => /^--(unsafe-paths|index|cached|3way|reject)$/.test(x) || x === '-3')).toBe(false)
      expect(a.some(x => x.startsWith('core.hooksPath='))).toBe(true)
    }
    expect(applies[0]).toContain('--check')
  })
})

describe('mergeInto: refused, the checkout byte-identical (R4)', () => {
  const refused = async (c: Case, expected: Partial<Extract<MergeOutcome, { ok: false }>>) => {
    const p = await prepare(c)
    const before = digest()
    const r = await merge(c, p)
    expect(r).toMatchObject({ ok: false, ...expected })
    expect(digest()).toEqual(before)
    return r
  }

  it('a touched path with an uncommitted edit: dirty with the path', async () => {
    w(R('a.txt'), 'mine\n')
    await refused({ edit: () => w(W('a.txt'), 'theirs\n') }, { reason: 'dirty', paths: ['a.txt'] })
  })

  it('a new path that is untracked in the checkout: dirty', async () => {
    w(R('n.txt'), 'mine\n')
    await refused({ edit: () => w(W('n.txt'), 'theirs\n') }, { reason: 'dirty', paths: ['n.txt'] })
  })

  it('a staged-only change on a touched path: dirty', async () => {
    const orig = readFileSync(R('b.txt'))
    w(R('b.txt'), 'staged\n')
    ug(['add', 'b.txt'])
    writeFileSync(R('b.txt'), orig)
    await refused({ edit: () => w(W('b.txt'), 'theirs\n') }, { reason: 'dirty', paths: ['b.txt'] })
  })

  it('a rename whose old path is dirty: dirty lists the old path', async () => {
    w(R('b.txt'), 'mine\n')
    await refused({ edit: () => execFileSync('mv', [W('b.txt'), W('moved.txt')]) }, { reason: 'dirty', paths: ['b.txt'] })
  })

  it('an untouched dirty file does not count', async () => {
    w(R('b.txt'), 'mine\n')
    expect(await merge({ edit: () => w(W('sub/c.txt'), 'c2\n') })).toEqual({ ok: true, files: 1 })
    expect(readFileSync(R('b.txt'), 'utf8')).toBe('mine\n')
  })

  it('the checkout moved so the context no longer applies: conflict, nothing written', async () => {
    const p = await prepare({ edit: () => w(W('a.txt'), readFileSync(W('a.txt'), 'utf8').replace('a5', 'A5')) })
    w(R('a.txt'), readFileSync(R('a.txt'), 'utf8').replace(/a[3-7]\n/g, 'x\n'))
    ug(['commit', '-qam', 'moved'])
    const before = digest()
    expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(digest()).toEqual(before)
  })

  it('a new path where the checkout has an ignored file: conflict', async () => {
    w(R('.gitignore'), '*.log\n')
    ug(['add', '-A'])
    ug(['commit', '-qm', 'ignore'])
    const p = await prepare({ end: b => craft(b, [{ path: 'x.log', mode: '100644', content: 'theirs\n' }]) })
    w(R('x.log'), 'mine\n')
    const before = digest()
    expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(digest()).toEqual(before)
  })

  it('merged once, then again: conflict', async () => {
    const p = await prepare({ edit: () => w(W('a.txt'), readFileSync(W('a.txt'), 'utf8').replace('a5', 'A5')) })
    expect(await merge({}, p)).toEqual({ ok: true, files: 1 })
    const before = digest()
    expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(digest()).toEqual(before)
  })

  describe('unsafe_path', () => {
    it.each([
      ['.gitattributes', '* filter=x\n'],
      ['sub/.gitmodules', '[submodule "x"]\n'],
      ['.lfsconfig', '[lfs]\n'],
      ['deep/.GitAttributes', 'x\n'],
    ])('%s from a real worktree edit', async (path, content) => {
      await refused({ edit: () => w(W(path), content) }, { reason: 'unsafe_path', paths: [path] })
    })

    it.each(['x/.git/config', 'X/.GIT/config', '.git/hooks/pre-commit', 'y/.git./config', 'z/.Git /config', 'w/.g‌it/config', '.gitmodules.', '.LFSCONFIG ', 'GIT~1/config'])(
      '%s in a hand-made tree',
      async path => {
        await refused({ end: b => craft(b, [{ path, mode: '100644', content: '[core]\n\tfsmonitor = touch /tmp/x\n' }]) }, { reason: 'unsafe_path', paths: [path] })
      },
    )

    it('a file under the checkout\'s in-tree core.hooksPath', async () => {
      ug(['config', 'core.hooksPath', '.githooks'])
      await refused({ edit: () => w(W('.githooks/pre-commit'), '#!/bin/sh\n') }, { reason: 'unsafe_path', paths: ['.githooks/pre-commit'] })
    })

    it('an absolute in-tree core.hooksPath, other case', async () => {
      ug(['config', 'core.hooksPath', join(repo, 'tools', 'hooks')])
      const path = process.platform === 'darwin' ? 'Tools/Hooks/post-checkout' : 'tools/hooks/post-checkout'
      await refused({ end: b => craft(b, [{ path, mode: '100755', content: '#!/bin/sh\n' }]) }, { reason: 'unsafe_path', paths: [path] })
    })

    it('a hooksPath outside the tree does not block ordinary files', async () => {
      ug(['config', 'core.hooksPath', join(root, 'elsewhere')])
      expect(await merge({ edit: () => w(W('n.txt'), 'n\n') })).toEqual({ ok: true, files: 1 })
    })

    it('a new symlink', async () => {
      await refused({ edit: () => symlinkSync('/etc/passwd', W('link')) }, { reason: 'unsafe_path', paths: ['link'] })
    })

    it('a file turned into a symlink', async () => {
      await refused({ edit: () => (unlinkSync(W('b.txt')), symlinkSync('a.txt', W('b.txt'))) }, { reason: 'unsafe_path', paths: ['b.txt'] })
    })

    it('a gitlink', async () => {
      await refused({ end: b => craft(b, [{ path: 'mod', mode: '160000', sha: b }]) }, { reason: 'unsafe_path', paths: ['mod'] })
    })

    it('a path under a submodule of the checkout', async () => {
      ug(['update-index', '--add', '--cacheinfo', `160000,${head()},lib`])
      ug(['commit', '-qm', 'gitlink'])
      await refused({ end: b => craft(b, [{ path: 'lib/x.txt', mode: '100644', content: 'x\n' }]) }, { reason: 'unsafe_path', paths: ['lib/x.txt'] })
    })

    it('one unsafe path refuses the whole patch', async () => {
      await refused({ edit: () => (w(W('ok.txt'), 'ok\n'), w(W('.gitattributes'), 'x\n')) }, { reason: 'unsafe_path', paths: ['.gitattributes'] })
      expect(existsSync(R('ok.txt'))).toBe(false)
    })

    it('a deleted symlink is fine', async () => {
      symlinkSync('a.txt', R('ln'))
      ug(['add', '-A'])
      ug(['commit', '-qm', 'ln'])
      expect(await merge({ edit: () => unlinkSync(W('ln')) })).toEqual({ ok: true, files: 1 })
      expect(existsSync(R('ln'))).toBe(false)
    })
  })

  describe('unsafe_repo', () => {
    it('the checkout configures a filter with a marker-writing command: refused, the marker absent', async () => {
      const mark = join(root, 'filter-ran')
      w(R('.gitattributes'), '*.txt filter=m\n')
      ug(['add', '-A'])
      ug(['commit', '-qm', 'attrs'])
      const p = await prepare({ edit: () => w(W('b.txt'), 'b2\n') })
      // 快照之后才出现的过滤器(CLI 改得到配置时就是这样)
      ug(['config', 'filter.m.clean', `sh -c 'touch ${mark}; cat'`])
      ug(['config', 'filter.m.smudge', `sh -c 'touch ${mark}; cat'`])
      const before = digest()
      expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'unsafe_repo' })
      expect(digest()).toEqual(before)
      expect(existsSync(mark)).toBe(false)
    })

    it('a core.fsmonitor command in the checkout never runs, and the merge goes through', async () => {
      const mark = join(root, 'fsmonitor-ran')
      w(join(root, 'mon.sh'), `#!/bin/sh\ntouch "${mark}"\n`)
      chmodSync(join(root, 'mon.sh'), 0o755)
      const p = await prepare({ edit: () => w(W('n.txt'), 'n\n') })
      ug(['config', 'core.fsmonitor', join(root, 'mon.sh')])
      expect(await merge({}, p)).toEqual({ ok: true, files: 1 })
      expect(existsSync(mark)).toBe(false)
    })

    it('the checkout pin no longer matches (the repo was swapped)', async () => {
      const p = await prepare({ edit: () => w(W('n.txt'), 'n\n') })
      const stale: PinnedRepo = { ...p.toPin, ids: { ...p.toPin.ids, gitDir: { dev: p.toPin.ids.gitDir.dev, ino: p.toPin.ids.gitDir.ino + 1 } } }
      const before = digest()
      const r = await mergeInto({ git: git(), from: { pin: p.fromPin, dir: wt, baseRef: p.baseRef, endRef: p.endRef }, to: { pin: stale, dir: repo }, exclude: [], tmpDir: tmp, gitOpts: {} })
      expect(r).toMatchObject({ ok: false, reason: 'unsafe_repo' })
      expect(digest()).toEqual(before)
    })
  })
})

describe('mergeInto: a failure halfway through git apply (R4)', () => {
  /** --check 照真的跑;真的 apply 时写一个新文件、改一个已跟踪的,然后退出 1 */
  const failing = (also?: (args: string[]) => { code: number } | undefined): Git => {
    const real = git()
    return async (args, o) => {
      const extra = also?.(args)
      if (extra) return { ...extra, stdout: Buffer.alloc(0), stderr: 'fatal: injected' }
      if (args.includes('apply') && !args.includes('--check')) {
        // git apply 写的是整个文件:写到的那些就是补丁的结果
        w(R('made/new.txt'), 'n\n')
        w(R('a.txt'), 'theirs\n')
        return { code: 1, stdout: Buffer.alloc(0), stderr: 'error: injected' }
      }
      return real(args, o)
    }
  }

  it('restored: the created path and its new directory are gone, the tracked file is back, conflict with restored:true', async () => {
    const p = await prepare({ edit: () => (w(W('made/new.txt'), 'n\n'), w(W('a.txt'), 'theirs\n')) })
    // checkout -- 会刷新索引里的 stat 缓存:比条目,不比字节
    const files = () => digest().filter(l => !l.startsWith('index:'))
    const before = [files(), ug(['ls-files', '-s'])]
    const r = await merge({ git: failing() }, p)
    expect(r).toEqual({ ok: false, reason: 'conflict', restored: true })
    expect(existsSync(R('made'))).toBe(false)
    expect([files(), ug(['ls-files', '-s'])]).toEqual(before)
  })

  it('the restore itself fails: restored:false with the paths, said as it is', async () => {
    const p = await prepare({ edit: () => (w(W('made/new.txt'), 'n\n'), w(W('a.txt'), 'theirs\n')) })
    const r = await merge({ git: failing(a => (a.includes('checkout') ? { code: 1 } : undefined)) }, p)
    expect(r).toMatchObject({ ok: false, reason: 'conflict', restored: false })
    expect((r as { paths: string[] }).paths).toContain('a.txt')
    expect(existsSync(R('made/new.txt'))).toBe(false)
  })
})

describe('review fixes (Task 2 review)', () => {
  const files = () => digest().filter(l => !l.startsWith('index:'))

  it('I1: two merges into one checkout never interleave: the second makes no git call while the first is applying', async () => {
    const p = await prepare({ edit: () => w(W('n.txt'), 'n\n') })
    const real = git()
    let release!: () => void
    const held = new Promise<void>(r => (release = r))
    let reached = false
    const a: Git = async (args, o) => {
      if (args.includes('apply') && !args.includes('--check')) {
        reached = true
        await held
      }
      return real(args, o)
    }
    const bCalls: string[][] = []
    const b: Git = (args, o) => (bCalls.push(args), real(args, o))
    const run = (g: Git) => mergeInto({ git: g, from: { pin: p.fromPin, dir: wt, baseRef: p.baseRef, endRef: p.endRef }, to: { pin: p.toPin, dir: repo }, exclude: [], tmpDir: tmp, gitOpts: {} })
    const first = run(a)
    await expect.poll(() => reached, { timeout: 10_000, interval: 5 }).toBe(true)
    const second = run(b)
    await new Promise(r => setTimeout(r, 300))
    expect(bCalls).toEqual([])
    release()
    expect(await first).toEqual({ ok: true, files: 1 })
    expect(await second).toMatchObject({ ok: false, reason: 'conflict' })
  })

  it('I1: a failed apply restores only what still equals the patch; another writer\'s edit and file stay, restored:false with their paths', async () => {
    w(R('d.txt'), 'd\n')
    w(R('y.txt'), 'y\n')
    ug(['add', '-A'])
    ug(['commit', '-qm', 'more'])
    const p = await prepare({
      edit: () => {
        w(W('a.txt'), 'theirs a\n')
        w(W('y.txt'), 'theirs y\n')
        w(W('z.txt'), 'theirs z\n')
        w(W('made/new.txt'), 'theirs new\n')
        unlinkSync(W('d.txt'))
      },
    })
    const before = readFileSync(R('a.txt'))
    const real = git()
    const failing: Git = async (args, o) => {
      if (args.includes('apply') && !args.includes('--check')) {
        // git apply wrote some of it, then someone else wrote y.txt and z.txt
        w(R('a.txt'), 'theirs a\n')
        w(R('made/new.txt'), 'theirs new\n')
        unlinkSync(R('d.txt'))
        w(R('y.txt'), 'someone else\n')
        w(R('z.txt'), 'someone else z\n')
        return { code: 1, stdout: Buffer.alloc(0), stderr: 'error: injected' }
      }
      return real(args, o)
    }
    const r = await merge({ git: failing }, p)
    expect(r).toMatchObject({ ok: false, reason: 'conflict', restored: false })
    expect([...(r as { paths: string[] }).paths].sort()).toEqual(['y.txt', 'z.txt'])
    expect(readFileSync(R('a.txt')).equals(before)).toBe(true)
    expect(readFileSync(R('d.txt'), 'utf8')).toBe('d\n')
    expect(existsSync(R('made'))).toBe(false)
    expect(readFileSync(R('y.txt'), 'utf8')).toBe('someone else\n')
    expect(readFileSync(R('z.txt'), 'utf8')).toBe('someone else z\n')
  })

  it.each([['assume-unchanged', '--assume-unchanged'], ['skip-worktree', '--skip-worktree']])('I2: a %s path is dirty, and it is left alone', async (_n, flag) => {
    ug(['update-index', flag, 'b.txt'])
    w(R('b.txt'), 'hidden local edit\n')
    const p = await prepare({ edit: () => w(W('b.txt'), 'theirs\n') })
    const before = files()
    expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'dirty', paths: ['b.txt'] })
    expect(files()).toEqual(before)
    expect(readFileSync(R('b.txt'), 'utf8')).toBe('hidden local edit\n')
  })

  it('I3: an NFD spelling of an in-tree hooksPath is unsafe_path', async () => {
    ug(['config', 'core.hooksPath', 'hooks-é'])
    const path = 'hooks-é/pre-commit'
    const p = await prepare({ end: b => craft(b, [{ path, mode: '100755', content: '#!/bin/sh\n' }]) })
    const before = files()
    expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'unsafe_path', paths: [path] })
    expect(files()).toEqual(before)
  })

  it('I3: a path whose existing parent resolves into the hooks dir (a committed link) is unsafe_path', async () => {
    mkdirSync(R('.githooks'))
    w(R('.githooks/keep'), 'k\n')
    symlinkSync('.githooks', R('hk'))
    ug(['add', '-A'])
    ug(['commit', '-qm', 'hooks link'])
    ug(['config', 'core.hooksPath', '.githooks'])
    const p = await prepare({ end: b => craft(b, [{ path: 'hk/pre-commit', mode: '100755', content: '#!/bin/sh\n' }]) })
    expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'unsafe_path', paths: ['hk/pre-commit'] })
    expect(existsSync(R('.githooks/pre-commit'))).toBe(false)
  })

  it('I3: an NFD spelling under a gitlink of the checkout is unsafe_path', async () => {
    ug(['update-index', '--add', '--cacheinfo', `160000,${head()},lib-é`])
    ug(['commit', '-qm', 'gitlink'])
    const path = 'lib-é/x.txt'
    const p = await prepare({ end: b => craft(b, [{ path, mode: '100644', content: 'x\n' }]) })
    expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'unsafe_path', paths: [path] })
  })

  it.each(['../evil.txt', 'd/./x.txt'])('M2: a %s tree entry is unsafe_path, not an error', async path => {
    const p = await prepare({ end: b => craft(b, [{ path, mode: '100644', content: 'x\n' }]) })
    const before = files()
    expect(await merge({}, p)).toMatchObject({ ok: false, reason: 'unsafe_path', paths: [path] })
    expect(files()).toEqual(before)
    expect(existsSync(join(root, 'evil.txt'))).toBe(false)
  })

  it('M5: the patch is capped while it is read; past the cap nothing is written', async () => {
    const p = await prepare({ edit: () => w(W('big.txt'), 'x'.repeat(4096)) })
    const before = files()
    await expect(mergeInto({ git: git(), from: { pin: p.fromPin, dir: wt, baseRef: p.baseRef, endRef: p.endRef }, to: { pin: p.toPin, dir: repo }, exclude: [], tmpDir: tmp, gitOpts: {}, maxPatchBytes: 1000 })).rejects.toThrow(/too large/)
    expect(files()).toEqual(before)
  })
})
