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
}

interface Entry {
  oldMode: string
  newMode: string
  oldSha: string
  status: string
  path: string
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

/** 比较用的段:去掉 HFS 忽略的码位、大小写折叠、去掉末尾的点和空格(APFS、NTFS 不分大小写,NTFS 不认段尾的点和空格) */
const fold = (seg: string) => seg.replace(HFS_IGNORABLE, '').toLowerCase().replace(/[. ]+$/, '')
const foldPath = (p: string) => p.split('/').map(fold)

/** 用户的 git(和 git-lfs)之后会读的文件 */
const GIT_NAMES = new Set(['.git', '.gitattributes', '.gitmodules', '.lfsconfig'])
const badSegment = (s: string) => GIT_NAMES.has(s) || /^git~\d+$/.test(s)

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
    const [oldMode, newMode, oldSha, , status] = parts[i].replace(/^:/, '').split(' ')
    out.push({ oldMode, newMode, oldSha, status: status?.[0] ?? '?', path: parts[i + 1] })
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
    const patch = await ok(g, [...PATCH_CONFIG, 'diff', '--binary', '--full-index', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', base, tree, '--', spec], { cwd: top, binary: true })
    return { entries, patch }
  })
}

/** 检出的 core.hooksPath 落在树内时,它相对树根的段(折叠过);不在树内 → undefined。各级配置都算:全局的相对路径对每个仓库都是树内 */
async function hooksDir(g: Git, pin: PinnedRepo): Promise<string[][]> {
  const r = await g(['config', '--get-all', 'core.hooksPath'], { cwd: pin.top })
  if (r.code !== 0) return []
  const out: string[][] = []
  for (const value of r.stdout.toString().split('\n').filter(Boolean)) {
    const expanded = value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(1)) : value
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(pin.top, expanded)
    const candidates = [abs]
    try {
      candidates.push(realpathSync.native(abs))
    } catch {
      // 不在:按字面算
    }
    for (const c of candidates) {
      if (!isInside(c, pin.top, process.platform)) continue
      const rel = relative(pin.top, c)
      out.push(rel === '' ? [] : rel.split(sep).map(fold))
    }
  }
  return out
}

/** 第 3 步:任何一条不安全,整个拒绝 */
async function unsafePaths(g: Git, to: PinnedRepo, entries: Entry[], patch: Buffer): Promise<string[]> {
  const hooks = await hooksDir(g, to)
  const gitlinks = splitZ(await ok(g, ['ls-files', '-s', '-z'], { cwd: to.top }))
    .filter(l => l.startsWith('160000 '))
    .map(l => foldPath(l.slice(l.indexOf('\t') + 1)))
  const bad = entries
    .filter(e => {
      const segs = foldPath(e.path)
      const linkish = e.status !== 'D' && (e.newMode === '120000' || e.newMode === '160000')
      return linkish || segs.some(badSegment) || hooks.some(h => under(segs, h)) || gitlinks.some(l => under(segs, l))
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

/** 第 5 步失败之后:已跟踪的 checkout 回索引里的样子(第 4 步保证它们等于索引),新建的删掉。返回还原不了的路径 */
async function restore(g: Git, to: PinnedRepo, tracked: string[], created: string[], dirs: string[]): Promise<string[]> {
  const failed: string[] = []
  const env = { GIT_LITERAL_PATHSPECS: '1' }
  for (let i = 0; i < tracked.length; i += CHUNK) {
    const chunk = tracked.slice(i, i + CHUNK)
    const r = await g(['-c', 'submodule.recurse=false', 'checkout', '--', ...chunk], { cwd: to.top, env }).catch(() => ({ code: -1 }))
    if (r.code !== 0) failed.push(...chunk)
  }
  for (const rel of created) {
    const p = inside(to.top, rel)
    if (p === undefined) {
      failed.push(rel)
      continue
    }
    try {
      if (!lexists(p)) continue
      if (lstatSync(p).isDirectory()) throw new Error('is a directory')
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
export async function mergeInto(o: MergeOpts): Promise<MergeOutcome> {
  const { to } = o
  if (!pinIntact(o.from.pin) || !pinIntact(to.pin)) return refuse('unsafe_repo')
  return guarded(pinnedGit(o.git, to.pin), o.tmpDir, async g => {
    // `git apply` 写工作区时走不走 clean/smudge 取决于 git 版本:有不安全的过滤器一律不合
    if (await hasUnsafeFilter(g, to.pin, o.gitOpts.writableRoots)) return refuse('unsafe_repo')
    const built = await buildPatch(o)
    if (!built) return refuse('nothing')
    const { entries, patch } = built
    // 读配置不跑任何钩子:不经 guarded,才读得到用户自己的 core.hooksPath
    const unsafe = await unsafePaths(pinnedGit(o.git, to.pin), to.pin, entries, patch)
    if (unsafe.length > 0) return refuse('unsafe_path', unsafe)
    const paths = entries.map(e => e.path)
    const dirty = await dirtyPaths(g, to.pin, paths)
    if (dirty.length > 0) {
      // 脏的原因就是这个补丁已经合过了:再合一次是冲突,不是用户的改动(§4.5 第 6 步)
      const merged = await g([...APPLY, '--check', '-R', '-'], { cwd: to.pin.top, input: patch })
      return merged.code === 0 ? refuse('conflict') : refuse('dirty', dirty)
    }
    const created = entries.filter(e => ZERO.test(e.oldMode)).map(e => e.path)
    const tracked = entries.filter(e => !ZERO.test(e.oldMode)).map(e => e.path)
    const dirs = missingDirs(to.pin.top, created)
    const check = await g([...APPLY, '--check', '-'], { cwd: to.pin.top, input: patch })
    if (check.code !== 0) return refuse('conflict')
    const applied = await g([...APPLY, '-'], { cwd: to.pin.top, input: patch }).catch(() => ({ code: -1 }))
    if (applied.code === 0) return { ok: true, files: entries.length }
    const failed = await restore(g, to.pin, tracked, created, dirs)
    return failed.length === 0 ? { ok: false, reason: 'conflict', restored: true } : { ok: false, reason: 'conflict', restored: false, paths: failed }
  })
}
