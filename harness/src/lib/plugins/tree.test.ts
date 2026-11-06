// 遍历、完整性、拷贝(09 spec §6.3):别人的目录只当数据,lstat 每一项,不跟随任何链接
import { afterEach, describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { copyTree, integrityOf, integrityOfSliced, TREE_LIMITS, TreeError, walkTree } from './tree'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'mff-tree-')))
  dirs.push(d)
  return d
}
function make(files: Record<string, string> = {}): string {
  const root = join(tmp(), 'root')
  mkdirSync(root)
  for (const [rel, v] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, v)
  }
  return root
}
const sparse = (root: string, rel: string, bytes: number) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '')
  truncateSync(p, bytes)
}
const MB = 1024 * 1024
const walked = (root: string) => {
  const r = walkTree(root)
  if (!r.ok) throw new Error(r.error)
  return r
}
const integrity = (root: string) => integrityOf(root, walked(root).files)
const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof TreeError) return e.code
    throw e
  }
  return 'no error'
}

describe('walkTree', () => {
  it('lists every file with size and exec bit, sorted, and sums the bytes', () => {
    const root = make({ 'b.txt': 'bb', 'a/c.txt': 'ccc' })
    chmodSync(join(root, 'b.txt'), 0o755)
    expect(walkTree(root)).toEqual({
      ok: true,
      bytes: 5,
      files: [
        { path: 'a/c.txt', size: 3, exec: false },
        { path: 'b.txt', size: 2, exec: true },
      ],
    })
  })

  it('pins the spec caps', () => {
    expect(TREE_LIMITS).toEqual({ maxFiles: 5000, maxBytes: 50 * MB, maxFileBytes: 20 * MB, maxDepth: 32 })
  })

  it('skips .git at any depth, as a dir, a file or another spelling, and does not count it', () => {
    const root = make({
      'a.txt': 'a',
      '.git/config': '[core]\n\tfsmonitor = ./evil\n',
      'sub/.git/config': '[core]\n\tfsmonitor = ./evil\n',
      'sub/x.txt': 'x',
      'gitfile/.git': 'gitdir: /somewhere\n',
      'other/.GIT/config': 'x',
    })
    const r = walked(root)
    expect(r.files.map(f => f.path)).toEqual(['a.txt', 'sub/x.txt'])
    expect(r.bytes).toBe(2)
    expect(walkTree(root, { maxFiles: 2 }).ok).toBe(true)
  })

  it('a link named .git is skipped, never followed', () => {
    const root = make({ 'a.txt': 'a', 'real/secret.txt': 's' })
    rmSync(join(root, 'real/secret.txt'))
    symlinkSync(tmp(), join(root, 'real/.git'))
    expect(walked(root).files.map(f => f.path)).toEqual(['a.txt'])
  })

  it('refuses a symlink anywhere and names it: file, dir, dangling, nested', () => {
    for (const [rel, target] of [['l', '/etc/hosts'], ['dirlink', '/etc'], ['dangling', '/nope/nope'], ['a/b/deep', '../..']] as const) {
      const root = make({ 'a/b/ok.txt': 'x' })
      symlinkSync(target, join(root, rel))
      expect(walkTree(root)).toEqual({ ok: false, error: 'symlink', path: rel })
    }
  })

  it('a root that is itself a link is refused', () => {
    const root = make({ 'a.txt': 'a' })
    const link = join(tmp(), 'link')
    symlinkSync(root, link)
    expect(walkTree(link)).toMatchObject({ ok: false, error: 'symlink' })
  })

  it('a root that is not a directory, or is missing, is refused', () => {
    const root = make({ 'a.txt': 'a' })
    expect(walkTree(join(root, 'a.txt'))).toMatchObject({ ok: false, error: 'bad_file_type' })
    expect(walkTree(join(root, 'nope'))).toMatchObject({ ok: false, error: 'bad_path' })
  })

  it('refuses a FIFO and names it', () => {
    const root = make({ 'sub/a.txt': 'a' })
    execFileSync('mkfifo', [join(root, 'sub/pipe')])
    expect(walkTree(root)).toEqual({ ok: false, error: 'bad_file_type', path: 'sub/pipe' })
  })

  it('refuses a hard link: it can be somebody else\'s file', () => {
    const root = make({ 'a.txt': 'a' })
    const outside = join(tmp(), 'id_rsa')
    writeFileSync(outside, 'key')
    linkSync(outside, join(root, 'b.txt'))
    expect(walkTree(root)).toEqual({ ok: false, error: 'bad_file_type', path: 'b.txt' })
  })

  it.each([
    ['newline', 'a\nb'],
    ['carriage return', 'a\rb'],
    ['tab', 'a\tb'],
    ['escape', 'a\x1bb'],
    ['del', 'a\x7fb'],
    ['bidi override', 'a\u202eb'],
    ['zero width', 'a\u200bb'],
    ['line separator', 'a\u2028b'],
    ['paragraph separator', 'a\u2029b'],
    ['backslash', 'a\\b'],
  ])('refuses a path with %s, and the reported path is clean', (_n, name) => {
    const root = make()
    writeFileSync(join(root, name), 'x')
    const r = walkTree(root)
    expect(r).toMatchObject({ ok: false, error: 'bad_path' })
    if (r.ok) return
    expect(r.path).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect(r.path).toContain('a')
  })

  it('a directory with a newline is refused before it is walked', () => {
    const root = make({ 'a\nb/x.txt': 'x' })
    expect(walkTree(root)).toMatchObject({ ok: false, error: 'bad_path' })
  })

  it.skipIf(process.platform === 'darwin')('a name that is not UTF-8 is refused', () => {
    const root = make()
    writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff, 0xfe])]), 'x')
    expect(walkTree(root)).toMatchObject({ ok: false, error: 'bad_path' })
  })

  it('reported paths are clipped', () => {
    const root = make()
    const long = 'x'.repeat(200)
    const path = join(root, long, long, long)
    mkdirSync(path, { recursive: true })
    symlinkSync('/etc', join(path, 'l'))
    const r = walkTree(root)
    expect(r).toMatchObject({ ok: false, error: 'symlink' })
    if (!r.ok) expect(r.path!.length).toBeLessThanOrEqual(300)
  })

  it('5000 files pass, the 5001st is refused', () => {
    const root = make()
    for (let i = 0; i < 5000; i++) writeFileSync(join(root, `f${i}`), '')
    expect(walkTree(root).ok).toBe(true)
    writeFileSync(join(root, 'one-more'), '')
    expect(walkTree(root)).toMatchObject({ ok: false, error: 'too_many_files' })
  })

  it('counts files across directories, not per directory', () => {
    const root = make({ 'a/1': '', 'b/2': '', 'c/3': '' })
    expect(walkTree(root, { maxFiles: 3 }).ok).toBe(true)
    expect(walkTree(root, { maxFiles: 2 })).toMatchObject({ ok: false, error: 'too_many_files' })
  })

  it('a pile of empty directories is bounded too', () => {
    const root = make()
    for (let i = 0; i < 30; i++) mkdirSync(join(root, `d${i}`))
    expect(walkTree(root, { maxFiles: 2 })).toMatchObject({ ok: false, error: 'too_many_files' })
  })

  it('directories spread over a tree are bounded in total, not per directory', () => {
    const root = make()
    for (const top of ['a', 'b', 'c']) for (let i = 0; i < 6; i++) mkdirSync(join(root, top, `d${i}`), { recursive: true })
    expect(walkTree(root, { maxFiles: 2 })).toMatchObject({ ok: false, error: 'too_many_files' })
  })

  it('the list is sorted by the whole path, not by walk order', () => {
    expect(walked(make({ 'a/x': '', 'a!': '' })).files.map(f => f.path)).toEqual(['a!', 'a/x'])
  })

  it('a 20 MB file passes, one byte more is file_too_large', () => {
    const root = make()
    sparse(root, 'big', 20 * MB)
    expect(walkTree(root).ok).toBe(true)
    truncateSync(join(root, 'big'), 20 * MB + 1)
    expect(walkTree(root)).toEqual({ ok: false, error: 'file_too_large', path: 'big' })
  })

  it('50 MB in total passes, one byte more is too_large', () => {
    const root = make()
    sparse(root, 'a', 20 * MB)
    sparse(root, 'b', 20 * MB)
    sparse(root, 'c', 10 * MB)
    expect(walkTree(root)).toMatchObject({ ok: true, bytes: 50 * MB })
    writeFileSync(join(root, 'd'), 'x')
    expect(walkTree(root)).toMatchObject({ ok: false, error: 'too_large' })
  })

  it('a path of 32 segments passes, 33 is too_deep', () => {
    const root = make()
    const segs = Array.from({ length: 31 }, () => 'd')
    mkdirSync(join(root, ...segs), { recursive: true })
    writeFileSync(join(root, ...segs, 'f'), 'x')
    expect(walkTree(root).ok).toBe(true)
    mkdirSync(join(root, ...segs, 'more'))
    writeFileSync(join(root, ...segs, 'more', 'f'), 'x')
    expect(walkTree(root)).toMatchObject({ ok: false, error: 'too_deep' })
  })

  it('a much deeper tree stops at the cap', () => {
    const root = make()
    mkdirSync(join(root, ...Array.from({ length: 200 }, () => 'd')), { recursive: true })
    expect(walkTree(root)).toMatchObject({ ok: false, error: 'too_deep' })
  })
})

describe('integrityOf', () => {
  it('the sliced form gives the same value and lets the event loop run between slices', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 40; i++) files[`d${i % 4}/f${i}.txt`] = 'x'.repeat(200_000 + i)
    const root = make(files)
    const { files: list } = walked(root)
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    try {
      expect(await integrityOfSliced(root, list, 0)).toBe(integrityOf(root, list))
    } finally {
      clearInterval(timer)
    }
    expect(ticks).toBeGreaterThan(0)
  })

  it('has the sha256 shape and is stable', () => {
    const root = make({ 'a.txt': 'a' })
    expect(integrity(root)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(integrity(root)).toBe(integrity(root))
  })

  it('file order, mtime and owner do not change it', () => {
    const root = make({ 'a.txt': 'a', 'b/c.txt': 'c', 'd.txt': 'd' })
    const before = integrity(root)
    const { files } = walked(root)
    expect(integrityOf(root, [...files].reverse())).toBe(before)
    utimesSync(join(root, 'a.txt'), 1000, 1000)
    const other = process.getgroups!().find(g => g !== statSync(join(root, 'a.txt')).gid)
    if (other !== undefined) chownSync(join(root, 'a.txt'), process.getuid!(), other)
    expect(integrity(root)).toBe(before)
  })

  it('the same tree elsewhere gives the same value: the path is relative', () => {
    expect(integrity(make({ 'a.txt': 'a', 'b/c': 'c' }))).toBe(integrity(make({ 'a.txt': 'a', 'b/c': 'c' })))
  })

  it('a byte, an exec bit and a rename change it', () => {
    const base = () => make({ 'a.txt': 'aaaa', 'b/c.txt': 'c' })
    const before = integrity(base())

    const byte = base()
    writeFileSync(join(byte, 'a.txt'), 'aaab')
    expect(integrity(byte)).not.toBe(before)

    const exec = base()
    chmodSync(join(exec, 'b/c.txt'), 0o755)
    expect(integrity(exec)).not.toBe(before)

    const moved = base()
    renameSync(join(moved, 'a.txt'), join(moved, 'z.txt'))
    expect(integrity(moved)).not.toBe(before)

    const sameOrder = base()
    renameSync(join(sameOrder, 'a.txt'), join(sameOrder, 'a2.txt'))
    expect(integrity(sameOrder)).not.toBe(before)
  })

  it('field boundaries are not ambiguous: moving bytes between name and content changes it', () => {
    expect(integrity(make({ ab: 'c' }))).not.toBe(integrity(make({ a: 'bc' })))
  })

  it('a link swapped in after the walk is refused, its target never hashed', () => {
    const root = make({ 'a.txt': 'a' })
    const { files } = walked(root)
    const outside = join(tmp(), 'secret')
    writeFileSync(outside, 'secret')
    rmSync(join(root, 'a.txt'))
    symlinkSync(outside, join(root, 'a.txt'))
    expect(code(() => integrityOf(root, files))).toBe('symlink')
  })

  it('a directory swapped for a link after the walk is refused', () => {
    const root = make({ 'sub/a.txt': 'a' })
    const { files } = walked(root)
    const elsewhere = join(tmp(), 'moved')
    renameSync(join(root, 'sub'), elsewhere)
    symlinkSync(elsewhere, join(root, 'sub'))
    expect(code(() => integrityOf(root, files))).toBe('symlink')
  })

  it('a FIFO swapped in after the walk is refused without blocking', () => {
    const root = make({ 'a.txt': 'a' })
    const { files } = walked(root)
    rmSync(join(root, 'a.txt'))
    execFileSync('mkfifo', [join(root, 'a.txt')])
    expect(code(() => integrityOf(root, files))).toBe('bad_file_type')
  })
})

describe('integrityOf and copyTree on a hard link swapped in', () => {
  it('is refused', () => {
    const root = make({ 'a.txt': 'a' })
    const { files } = walked(root)
    const outside = join(tmp(), 'id_rsa')
    writeFileSync(outside, 'key')
    rmSync(join(root, 'a.txt'))
    linkSync(outside, join(root, 'a.txt'))
    expect(code(() => integrityOf(root, files))).toBe('bad_file_type')
  })
})

describe('copyTree', () => {
  const dest = () => join(tmp(), 'to')

  it('copies files with fixed modes, leaving .git behind at any depth', () => {
    const root = make({ 'a.txt': 'a', 'sub/x.sh': '#!/bin/sh\n', '.git/config': 'evil', 'sub/.git/config': 'evil', 'empty/.keep': '' })
    chmodSync(join(root, 'sub/x.sh'), 0o775)
    chmodSync(join(root, 'a.txt'), 0o600)
    mkdirSync(join(root, 'bare'), { mode: 0o700 })
    const to = dest()
    copyTree(root, to, { exclude: ['.git'] })
    expect(readFileSync(join(to, 'a.txt'), 'utf8')).toBe('a')
    expect(existsSync(join(to, '.git'))).toBe(false)
    expect(existsSync(join(to, 'sub/.git'))).toBe(false)
    expect(lstatSync(join(to, 'a.txt')).mode & 0o7777).toBe(0o644)
    expect(lstatSync(join(to, 'sub/x.sh')).mode & 0o7777).toBe(0o755)
    expect(lstatSync(join(to, 'sub')).mode & 0o7777).toBe(0o755)
    expect(lstatSync(join(to, 'bare')).mode & 0o7777).toBe(0o755)
    expect(integrity(to)).toBe(integrityOf(root, walked(root).files))
  })

  it('setuid and setgid bits do not survive', () => {
    const root = make({ 'x.sh': 'x' })
    chmodSync(join(root, 'x.sh'), 0o6755)
    const to = dest()
    copyTree(root, to)
    expect(lstatSync(join(to, 'x.sh')).mode & 0o7777).toBe(0o755)
  })

  it('.git stays out even when the caller leaves it off the list', () => {
    const root = make({ 'a.txt': 'a', 'sub/.git/config': 'evil' })
    const to = dest()
    copyTree(root, to, { exclude: [] })
    expect(existsSync(join(to, 'sub/.git'))).toBe(false)
  })

  it('other excluded names are left out at any depth', () => {
    const root = make({ 'a.txt': 'a', 'skip/x': 'x', 'b/skip/y': 'y' })
    const to = dest()
    copyTree(root, to, { exclude: ['.git', 'skip'] })
    expect(existsSync(join(to, 'skip'))).toBe(false)
    expect(existsSync(join(to, 'b/skip'))).toBe(false)
    expect(existsSync(join(to, 'a.txt'))).toBe(true)
  })

  it('a link already there is refused and nothing is left', () => {
    const root = make({ 'a.txt': 'a' })
    symlinkSync('/etc/hosts', join(root, 'l'))
    const to = dest()
    expect(code(() => copyTree(root, to))).toBe('symlink')
    expect(existsSync(to)).toBe(false)
  })

  it('a link swapped in between walk and open is refused by O_NOFOLLOW, its target not copied', () => {
    const root = make({ 'a.txt': 'a', 'z.txt': 'z' })
    const secret = join(tmp(), 'secret')
    writeFileSync(secret, 'SECRET')
    const to = dest()
    const c = code(() =>
      copyTree(root, to, {
        beforeOpen: rel => {
          if (rel !== 'z.txt') return
          rmSync(join(root, rel))
          symlinkSync(secret, join(root, rel))
        },
      }),
    )
    expect(c).toBe('symlink')
    expect(existsSync(to)).toBe(false)
  })

  it('a directory swapped for a link between walk and open is refused', () => {
    const root = make({ 'sub/a.txt': 'a' })
    const elsewhere = join(tmp(), 'elsewhere')
    const to = dest()
    const c = code(() =>
      copyTree(root, to, {
        beforeOpen: () => {
          renameSync(join(root, 'sub'), elsewhere)
          symlinkSync(elsewhere, join(root, 'sub'))
        },
      }),
    )
    expect(c).toBe('symlink')
    expect(existsSync(to)).toBe(false)
  })

  it('a FIFO swapped in is refused without blocking', () => {
    const root = make({ 'a.txt': 'a' })
    const to = dest()
    const c = code(() =>
      copyTree(root, to, {
        beforeOpen: rel => {
          rmSync(join(root, rel))
          execFileSync('mkfifo', [join(root, rel)])
        },
      }),
    )
    expect(c).toBe('bad_file_type')
    expect(existsSync(to)).toBe(false)
  })

  it('another file swapped in, or a file that grew, is refused', () => {
    const swapped = make({ 'a.txt': 'a' })
    const to = dest()
    expect(
      code(() =>
        copyTree(swapped, to, {
          beforeOpen: rel => {
            rmSync(join(swapped, rel))
            writeFileSync(join(swapped, rel), 'b')
            writeFileSync(join(swapped, 'keep-inode-busy'), '')
          },
        }),
      ),
    ).toBe('changed')
    expect(existsSync(to)).toBe(false)

    const grown = make({ 'a.txt': 'a' })
    expect(code(() => copyTree(grown, to, { beforeOpen: rel => writeFileSync(join(grown, rel), 'a much longer body') }))).toBe('changed')
    expect(existsSync(to)).toBe(false)
  })

  // 分大小写的来源拷到不分大小写的目标时 Foo 和 foo 撞车;这个卷造不出来,用预先放好的目标代替
  it('a file whose target already exists is bad_path with the relative path, nothing absolute', () => {
    const root = make({ 'sub/foo': 'a' })
    const to = dest()
    let err: unknown
    try {
      copyTree(root, to, {
        beforeOpen: rel => writeFileSync(join(to, rel), 'there first'),
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TreeError)
    expect(err).toMatchObject({ code: 'bad_path', path: 'sub/foo' })
    expect((err as Error).message).not.toContain(to)
    expect(existsSync(to)).toBe(false)
  })

  it('a directory whose target already exists is bad_path with the relative path', () => {
    const root = make({ 'sub/foo': 'a' })
    const to = dest()
    let err: unknown
    try {
      copyTree(root, to, { beforeMkdir: rel => mkdirSync(join(to, rel)) })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TreeError)
    expect(err).toMatchObject({ code: 'bad_path', path: 'sub' })
    expect((err as Error).message).not.toContain(to)
    expect(existsSync(to)).toBe(false)
  })

  it('walk limits apply to the copy', () => {
    const root = make({ a: '', b: '', c: '' })
    const to = dest()
    expect(code(() => copyTree(root, to, { limits: { maxFiles: 2 } }))).toBe('too_many_files')
    expect(existsSync(to)).toBe(false)
  })

  it('a destination that exists with content, or is a link, is refused and left alone', () => {
    const root = make({ 'a.txt': 'a' })
    const full = make({ 'keep.txt': 'k' })
    expect(code(() => copyTree(root, full))).toBe('bad_path')
    expect(readFileSync(join(full, 'keep.txt'), 'utf8')).toBe('k')

    const target = make()
    const link = join(tmp(), 'link')
    symlinkSync(target, link)
    expect(code(() => copyTree(root, link))).toBe('symlink')
    expect(existsSync(join(target, 'a.txt'))).toBe(false)
  })
})
