// 编码工具共用的路径与文件操作(Task 3 M4 / M5):
// - 工具只碰 permission() 时算出、交给权限门的那个路径(按 args 对象记住),执行前再解析一次,变了就不做;
// - 打开文件一律 O_NOFOLLOW(平台支持时),末段在检查后被换成符号链接 → 打开失败;
// - 建父目录逐级来,每建一级都 realpath 核对;写之前再过一次检查(还在 cwd 内、不在黑名单)
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, relative, isAbsolute } from 'node:path'
import { isInside, OUTSIDE, resolveToolPath } from '../../lib/fs/paths'
import type { ToolContext } from '../../lib/tools/types'

/** Windows 没有 O_NOFOLLOW → 0(只剩执行前的再解析核对) */
export const O_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0

/** 同一路径(darwin / win32 不区分大小写,与权限门同一套比较) */
export const samePath = (a: string, b: string) => isInside(a, b, process.platform) && isInside(b, a, process.platform)

const memo = new WeakMap<object, Map<string, string>>()

/**
 * 参数里的路径 → 解析后的绝对路径。permission() 里第一次算并记在 args 对象上,
 * run() 拿到的是同一个对象,于是用的正是权限门放行的那个值
 */
export function pathFor(args: object, ctx: ToolContext, raw: string): string {
  let m = memo.get(args)
  if (!m) memo.set(args, (m = new Map()))
  const key = `${ctx.cwd}\0${raw}`
  let p = m.get(key)
  if (p === undefined) m.set(key, (p = resolveToolPath(ctx.cwd, raw)))
  return p
}

/** 执行前再解析一次:与放行时的结果不同(中途换了符号链接)→ 抛错,什么都不做 */
export function stillSame(ctx: ToolContext, raw: string, approved: string): void {
  const now = resolveToolPath(ctx.cwd, raw)
  if (approved === OUTSIDE || now === OUTSIDE || !samePath(now, approved)) throw new Error(`路径在权限检查之后发生了变化,未执行:${raw}`)
}

/** 给模型看的路径:cwd 内用相对路径,其他(如 spillDir)用绝对路径 */
export function shownPath(ctx: ToolContext, p: string): string {
  const r = relative(ctx.cwd, p)
  if (r === '') return '.'
  return r.startsWith('..') || isAbsolute(r) ? p : r
}

const lexists = (p: string) => {
  try {
    lstatSync(p)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw e
  }
}

const changed = (p: string) => new Error(`路径在权限检查之后发生了变化,未执行:${p}`)

/** 逐级建目录;最近存在的祖先与每个新建的目录都要 realpath 回自己(中途换成链接 → 停,最多多建一级) */
export function mkdirChecked(dir: string): void {
  const missing: string[] = []
  let cur = dir
  while (!lexists(cur)) {
    const up = dirname(cur)
    if (up === cur) throw changed(dir)
    missing.unshift(cur)
    cur = up
  }
  if (!samePath(realpathSync.native(cur), cur)) throw changed(cur)
  if (!lstatSync(cur).isDirectory()) throw new Error(`不是目录:${cur}`)
  for (const d of missing) {
    try {
      mkdirSync(d)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const st = lstatSync(d)
    if (st.isSymbolicLink() || !st.isDirectory() || !samePath(realpathSync.native(d), d)) throw changed(d)
  }
}

/** 读整个文件(不跟随末段链接);目录、超过 maxBytes → 抛错 */
export function readNoFollow(p: string, maxBytes = Infinity): Buffer {
  const fd = openSync(p, constants.O_RDONLY | O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (st.isDirectory()) throw new Error(`是目录,不是文件:${p}`)
    if (st.size > maxBytes) throw new Error(`文件过大(${st.size} 字节,上限 ${maxBytes}):${p}`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 建父目录 → recheck(再解析、再过权限门)→ O_NOFOLLOW 打开并覆盖写。
 * recheck 返回 false → 抛错,不写
 */
export function writeChecked(p: string, content: string, recheck: () => boolean): void {
  mkdirChecked(dirname(p))
  if (!recheck()) throw changed(p)
  // 不带 O_TRUNC:先确认是普通文件、没有别的硬链接(cwd 里指向凭据文件的硬链接 realpath 看不出来),再截断
  const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | O_NOFOLLOW, 0o666)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(`不是普通文件:${p}`)
    if (st.nlink > 1) throw new Error(`文件有多个硬链接,不写:${p}`)
    ftruncateSync(fd, 0)
    const buf = Buffer.from(content, 'utf8')
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
  } finally {
    closeSync(fd)
  }
}

/**
 * 删除一个普通文件:recheck(再解析、再过权限门)→ 父目录 realpath 回自己 → lstat 是普通文件 → unlink。
 * unlink 本身不跟随末段链接;父目录中途被换成链接 → 抛错,不删
 */
export function deleteChecked(p: string, recheck: () => boolean): void {
  if (!recheck()) throw changed(p)
  const dir = dirname(p)
  if (!samePath(realpathSync.native(dir), dir)) throw changed(p)
  if (!lstatSync(p).isFile()) throw new Error(`不是普通文件:${p}`)
  unlinkSync(p)
}
