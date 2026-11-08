// 把 worktree 的改动合进用户的检出(08 §4.5、评审修订 R4)。补丁是不受信的 CLI 写出来的,要进用户不在沙箱里的 git:
// 只认两张快照之间的 diff,改名拆成删 + 增,任何 git 之后会读的路径、链接、子模块整个拒绝;脏的路径不碰;
// `git apply` 只在检查阶段是全有或全无,写到一半失败时按记下的路径还原,并照实报告还原成没成。纯 git,不碰内核
import { lstatSync, realpathSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MergeRefusalReason } from '../../protocol/tools'
import { hasGitSegment, isInside } from '../fs/paths'
import { lexists, removeLeaf, samePath } from '../fs/safeFs'
import { guarded, hasUnsafeFilter, pinIntact, pinnedGit, repoPrefix, type Git, type PinnedRepo } from './snapshot'

export type MergeOutcome = { ok: true; files: number } | { ok: false; reason: MergeRefusalReason; paths?: string[]; restored?: boolean }

export interface GitOpts {
  /** 沙箱写得到的根(仓库之外):过滤器落在里面就算不安全 */
  writableRoots?: string[]
}

export interface MergeOpts {
  git: Git
  /** dir:运行的 cwd(在 worktree 里),只合它这个前缀下的 */
  from: { pin: PinnedRepo; dir: string; baseRef: string; endRef: string }
  /** 用户的检出:会话钉住的仓库,调用方已重新 pinRepo 核对过身份 */
  to: { pin: PinnedRepo; dir: string }
  /** 绝对路径:worktree 里 `deny read` 根的副本。它们在补丁里是删除,不去掉就把用户的文件删了 */
  exclude: string[]
  tmpDir: string
  gitOpts: GitOpts
  /** 补丁边读边截的上限,默认 128 MB:超了抛错,什么都不写 */
  maxPatchBytes?: number
}

interface Entry {
  oldMode: string
  newMode: string
  oldSha: string
  /** 补丁之后的 blob:还原时只动还等于它的文件 */
  newSha: string
  status: string
  path: string
}

const MAX_PATCH = 128 << 20

/** 同一个检出同一时间只有一次合并:另一次的还原会把这一次写下的当成自己的(review I1) */
const locks = new Map<string, Promise<unknown>>()
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return run
}

const CHUNK = 200
const ZERO = /^0+$/

const splitZ = (b: Buffer) => b.toString().split('\0').filter(s => s !== '')

const refuse = (reason: MergeRefusalReason, paths?: string[]): MergeOutcome => ({ ok: false, reason, ...(paths && paths.length > 0 && { paths }) })

/** 补丁的输出不跟着用户配置变:前缀、相对路径、子模块的写法、颜色 */
const PATCH_CONFIG = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false', '-c', 'diff.submodule=short', '-c', 'core.quotePath=true']
const DIFF_FLAGS = ['--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none']

/**
 * `git apply` 的选项:保护 .git 的大小写和 NTFS 变体,空白不改写(apply.whitespace=fix 会改内容),
 * 不放宽匹配;不加 --unsafe-paths、--index、--3way、--reject
 */
const APPLY = ['-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true', '-c', 'apply.whitespace=nowarn', '-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', '-p1']

/** HFS+ 忽略的码位:`.g‌it` 在 macOS 上就是 `.git` */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g

/**
 * 比较用的段:NFC(APFS、HFS+ 不分 NFC / NFD,review I3)、去掉 HFS 忽略的码位、大小写折叠、去掉末尾的点和空格(APFS、NTFS 不分大小写,NTFS 不认段尾的点和空格)。
 * `.`、`..` 折叠后是空串,badSegment 拒绝
 */
const fold = (seg: string) => seg.normalize('NFC').replace(HFS_IGNORABLE, '').toLowerCase().replace(/[. ]+$/, '')
const foldPath = (p: string) => p.split('/').map(fold)

/** 用户的 git(和 git-lfs)之后会读的文件 */
const GIT_NAMES = new Set(['.git', '.gitattributes', '.gitmodules', '.lfsconfig'])
const badSegment = (s: string) => s === '' || GIT_NAMES.has(s) || /^git~\d+$/.test(s)

/** 按 NFC 再比:realpath 给的是磁盘上的拼法,补丁里的可能是另一种 */
const within = (child: string, parent: string) => isInside(child.normalize('NFC'), parent.normalize('NFC'), process.platform)

const realOrUndefined = (p: string) => {
  try {
    return realpathSync.native(p)
  } catch {
    return undefined
  }
}

const under = (path: string[], dir: string[]) => dir.length <= path.length && dir.every((s, i) => s === path[i])

async function ok(g: Git, args: string[], o: Parameters<Git>[1]): Promise<Buffer> {
  const r = await g(args, o)
  if (r.code !== 0) throw new Error(`git ${args.find((a, i) => a !== '-c' && args[i - 1] !== '-c')} failed (${r.code}): ${r.stderr.split('\n')[0]}`)
  return r.stdout
}

/** `--raw -z --no-abbrev` 的输出 */
function parseRaw(b: Buffer): Entry[] {
  const parts = splitZ(b)
  const out: Entry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha, status] = parts[i].replace(/^:/, '').split(' ')
    out.push({ oldMode, newMode, oldSha, newSha, status: status?.[0] ?? '?', path: parts[i + 1] })
  }
  return out
}

/** 补丁头里的新模式:raw 之外再看一遍,链接和子模块不能从哪条缝溜进去 */
function patchModes(patch: Buffer): boolean {
  for (const line of patch.toString('latin1').split('\n')) {
    const m = /^(?:new file mode|new mode|index [0-9a-f]+\.\.[0-9a-f]+) (\d{6})$/.exec(line)
    if (m && (m[1] === '120000' || m[1] === '160000')) return true
  }
  return false
}

const scope = (prefix: string) => (prefix ? `:(top,literal)${prefix}` : ':/')

/** 第 1、2 步:base..end 的改动,去掉 exclude(在临时索引里把它们放回 base 的样子),再出补丁 */
async function buildPatch(o: MergeOpts): Promise<{ entries: Entry[]; patch: Buffer } | undefined> {
  const maxBytes = o.maxPatchBytes ?? MAX_PATCH
  const { from } = o
  return guarded(pinnedGit(o.git, from.pin), o.tmpDir, async (g, dir) => {
    const top = from.pin.top
    const commit = async (ref: string) => (await ok(g, ['rev-parse', '-q', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: top })).toString().trim()
    const base = await commit(from.baseRef)
    const end = await commit(from.endRef)
    const spec = scope(repoPrefix(from.pin, from.dir))
    const raw = (to: string) => ok(g, ['diff', '--raw', '-z', '--no-abbrev', ...DIFF_FLAGS, base, to, '--', spec], { cwd: top })
    let tree = (await ok(g, ['rev-parse', '--verify', `${end}^{tree}`], { cwd: top })).toString().trim()
    const all = parseRaw(await raw(tree))
    const excluded = all.filter(e => o.exclude.some(x => isInside(join(top, ...e.path.split('/')), x, process.platform)))
    if (excluded.length > 0) {
      const env = { GIT_INDEX_FILE: join(dir, 'index') }
      await ok(g, ['read-tree', end], { cwd: top, env })
      // mode 0 = 从索引里去掉(base 里本来没有)
      const info = excluded.map(e => `${ZERO.test(e.oldMode) ? '0' : e.oldMode} ${e.oldSha}\t${e.path}\0`).join('')
      await ok(g, ['update-index', '-z', '--index-info'], { cwd: top, env, input: Buffer.from(info) })
      tree = (await ok(g, ['write-tree', '--missing-ok'], { cwd: top, env })).toString().trim()
    }
    const entries = excluded.length > 0 ? parseRaw(await raw(tree)) : all
    if (entries.length === 0) return undefined
    const r = await g([...PATCH_CONFIG, 'diff', '--binary', '--full-index', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', base, tree, '--', spec], { cwd: top, binary: true, maxBytes })
    if (r.truncated) throw new Error('patch too large')
    if (r.code !== 0) throw new Error(`git diff failed (${r.code}): ${r.stderr.split('\n')[0]}`)
    return { entries, patch: r.stdout }
  })
}

/** 检出的 core.hooksPath 落在树内时,它相对树根的段(折叠过);不在树内 → undefined。各级配置都算:全局的相对路径对每个仓库都是树内 */
async function hooksDir(g: Git, pin: PinnedRepo): Promise<{ segs: string[][]; reals: string[] }> {
  const r = await g(['config', '--get-all', 'core.hooksPath'], { cwd: pin.top })
  const reals: string[] = []
  if (r.code !== 0) return { segs: [], reals }
  const out: string[][] = []
  for (const value of r.stdout.toString().split('\n').filter(Boolean)) {
    const expanded = value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(1)) : value
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(pin.top, expanded)
    const candidates = [abs]
    const real = realOrUndefined(abs)
    if (real !== undefined) candidates.push(real)
    for (const c of candidates) {
      if (!within(c, pin.top)) continue
      const rel = relative(pin.top, c)
      out.push(rel === '' ? [] : rel.split(sep).map(fold))
      if (c === real) reals.push(real)
    }
  }
  return { segs: out, reals }
}

/**
 * 补丁路径最深的已有祖先(或它自己)realpath 之后落在哪:钩子目录、子模块里,出了树、进了 .git,或解析不了(悬空的链接)都算不安全。
 * 段比较拦不住树里提交过的链接(hk → .githooks)
 */
function resolvesUnsafe(top: string, rel: string, dirs: string[]): boolean {
  let d = join(top, ...rel.split('/'))
  while (!lexists(d)) d = dirname(d)
  if (samePath(d, top)) return false
  const real = realOrUndefined(d)
  if (real === undefined || !within(real, top) || hasGitSegment(real, process.platform)) return true
  return dirs.some(h => within(real, h))
}

/** 第 3 步:任何一条不安全,整个拒绝 */
async function unsafePaths(g: Git, plain: Git, to: PinnedRepo, entries: Entry[], patch: Buffer): Promise<string[]> {
  const hooks = await hooksDir(plain, to)
  const linkPaths = splitZ(await ok(g, ['ls-files', '-s', '-z'], { cwd: to.top }))
    .filter(l => l.startsWith('160000 '))
    .map(l => l.slice(l.indexOf('\t') + 1))
  const gitlinks = linkPaths.map(foldPath)
  const realDirs = [...hooks.reals, ...linkPaths.map(l => realOrUndefined(join(to.top, ...l.split('/')))).filter((x): x is string => x !== undefined)]
  const bad = entries
    .filter(e => {
      const raw = e.path.split('/')
      if (raw.some(s => s === '' || s === '.' || s === '..')) return true
      const segs = foldPath(e.path)
      const linkish = e.status !== 'D' && (e.newMode === '120000' || e.newMode === '160000')
      return linkish || segs.some(badSegment) || hooks.segs.some(h => under(segs, h)) || gitlinks.some(l => under(segs, l)) || resolvesUnsafe(to.top, e.path, realDirs)
    })
    .map(e => e.path)
  if (bad.length === 0 && patchModes(patch)) return entries.map(e => e.path)
  return bad
}

/** 第 4 步:这些路径有没提交的改动(工作区、暂存、未跟踪)。不写用户的索引 */
async function dirtyPaths(g: Git, to: PinnedRepo, paths: string[]): Promise<string[]> {
  const out: string[] = []
  const env = { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' }
  for (let i = 0; i < paths.length; i += CHUNK) {
    const args = ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all', '--', ...paths.slice(i, i + CHUNK)]
    for (const item of splitZ(await ok(g, args, { cwd: to.top, env }))) out.push(item.slice(3))
    // assume-unchanged(小写)、skip-worktree(S)的本地改动 status 看不见(review I2):一律算脏
    const tags = ['ls-files', '-v', '-z', '--full-name', '--', ...paths.slice(i, i + CHUNK)]
    for (const item of splitZ(await ok(g, tags, { cwd: to.top, env }))) if (item[0] !== 'H') out.push(item.slice(2))
  }
  return [...new Set(out)]
}

/** 树内的目标路径:没有 `.`、`..`、空段,不在 .git 下,父目录 realpath 后仍在树内(中途是链接 → undefined) */
function inside(top: string, rel: string): string | undefined {
  const segs = rel.split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) return undefined
  const p = join(top, ...segs)
  if (hasGitSegment(p, process.platform)) return undefined
  try {
    const parent = realpathSync.native(dirname(p))
    if (!isInside(parent, top, process.platform) || !samePath(parent, dirname(p))) return undefined
  } catch {
    return p // 父目录不在:这个路径也不在
  }
  return p
}

/** 补丁要新建的路径上还没有的父目录,由深到浅 */
function missingDirs(top: string, created: string[]): string[] {
  const dirs = new Set<string>()
  for (const rel of created) {
    let d = dirname(join(top, ...rel.split('/')))
    while (isInside(d, top, process.platform) && !samePath(d, top) && !lexists(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  return [...dirs].sort((a, b) => b.length - a.length)
}

/** 这些文件现在的 blob(不跑过滤器);不是普通文件的(链接、目录)、不在的不出现 */
async function blobs(g: Git, top: string, rels: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  const files = rels.filter(rel => {
    const p = inside(top, rel)
    try {
      return p !== undefined && lstatSync(p).isFile()
    } catch {
      return false
    }
  })
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK)
    const r = await g(['hash-object', '--no-filters', '--', ...chunk], { cwd: top }).catch(() => ({ code: -1, stdout: Buffer.alloc(0) }))
    if (r.code !== 0) continue
    const shas = r.stdout.toString().split('\n').filter(Boolean)
    chunk.forEach((rel, j) => shas[j] && m.set(rel, shas[j]))
  }
  return m
}

/**
 * 第 5 步失败之后(review I1):只动还等于补丁结果的。已跟踪的:等于补丁之后的 blob → checkout 回索引(第 4 步保证索引就是之前);
 * 删除的:不在了 → checkout;还是原来的 → 不用动。新建的:等于补丁的 blob → 删掉。别的都是别人写的,不碰,报出来。
 * git apply 写一半和写完了都是退出码 1,分不出来:全靠逐个比字节
 */
async function restore(g: Git, to: PinnedRepo, entries: Entry[], dirs: string[]): Promise<string[]> {
  const failed: string[] = []
  const now = await blobs(g, to.top, entries.map(e => e.path))
  const present = (rel: string) => {
    const p = inside(to.top, rel)
    return p === undefined || lexists(p)
  }
  const checkout: string[] = []
  const remove: string[] = []
  for (const e of entries) {
    const sha = now.get(e.path)
    const exists = present(e.path)
    if (ZERO.test(e.oldMode)) {
      if (!exists) continue
      if (sha === e.newSha) remove.push(e.path)
      else failed.push(e.path)
    } else if (e.status === 'D') {
      if (!exists) checkout.push(e.path)
      else if (sha !== e.oldSha) failed.push(e.path)
    } else if (sha === e.newSha) checkout.push(e.path)
    else if (sha !== e.oldSha || !exists) failed.push(e.path)
  }
  const env = { GIT_LITERAL_PATHSPECS: '1' }
  for (let i = 0; i < checkout.length; i += CHUNK) {
    const chunk = checkout.slice(i, i + CHUNK)
    const r = await g(['-c', 'submodule.recurse=false', 'checkout', '--', ...chunk], { cwd: to.top, env }).catch(() => ({ code: -1 }))
    if (r.code !== 0) failed.push(...chunk)
  }
  for (const rel of remove) {
    const p = inside(to.top, rel)
    try {
      if (p === undefined) throw new Error('outside')
      removeLeaf(p)
    } catch {
      failed.push(rel)
    }
  }
  for (const d of dirs) {
    try {
      rmdirSync(d)
    } catch {
      // 里面还有东西(不是我们建的),或者本来就没建出来
    }
  }
  return failed
}

/** spec §4.5 第 1–6 步 */
export function mergeInto(o: MergeOpts): Promise<MergeOutcome> {
  return exclusive(`${o.to.pin.commonDir}\0${o.to.pin.top}`, () => mergeNow(o))
}

async function mergeNow(o: MergeOpts): Promise<MergeOutcome> {
  const { to } = o
  if (!pinIntact(o.from.pin) || !pinIntact(to.pin)) return refuse('unsafe_repo')
  return guarded(pinnedGit(o.git, to.pin), o.tmpDir, async g => {
    // `git apply` 写工作区时走不走 clean/smudge 取决于 git 版本:有不安全的过滤器一律不合
    if (await hasUnsafeFilter(g, to.pin, o.gitOpts.writableRoots)) return refuse('unsafe_repo')
    const built = await buildPatch(o)
    if (!built) return refuse('nothing')
    const { entries, patch } = built
    // 只有读 core.hooksPath 这一条不经 guarded(否则读到的是我们的空目录):`git config` 不读索引,不跑钩子和 fsmonitor
    const unsafe = await unsafePaths(g, pinnedGit(o.git, to.pin), to.pin, entries, patch)
    if (unsafe.length > 0) return refuse('unsafe_path', unsafe)
    const paths = entries.map(e => e.path)
    const dirty = await dirtyPaths(g, to.pin, paths)
    if (dirty.length > 0) {
      // 脏的原因就是这个补丁已经合过了:再合一次是冲突,不是用户的改动(§4.5 第 6 步)
      const merged = await g([...APPLY, '--check', '-R', '-'], { cwd: to.pin.top, input: patch })
      return merged.code === 0 ? refuse('conflict') : refuse('dirty', dirty)
    }
    const dirs = missingDirs(to.pin.top, entries.filter(e => ZERO.test(e.oldMode)).map(e => e.path))
    const check = await g([...APPLY, '--check', '-'], { cwd: to.pin.top, input: patch })
    if (check.code !== 0) return refuse('conflict')
    const applied = await g([...APPLY, '-'], { cwd: to.pin.top, input: patch }).catch(() => ({ code: -1 }))
    if (applied.code === 0) return { ok: true, files: entries.length }
    const failed = await restore(g, to.pin, entries, dirs)
    return failed.length === 0 ? { ok: false, reason: 'conflict', restored: true } : { ok: false, reason: 'conflict', restored: false, paths: failed }
  })
}
