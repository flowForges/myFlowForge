// 遍历、完整性、拷贝(09 spec §6.3),两种来源共用。别人的目录只当数据:lstat 每一项,不跟随链接,打开带 O_NOFOLLOW
import { createHash } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { O_NOFOLLOW } from '../fs/safeFs'
import { clip } from './types'

export interface TreeFile {
  /** 相对根,斜杠分隔 */
  path: string
  size: number
  exec: boolean
}

export interface TreeLimits {
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
  /** 路径段数上限,文件名算一段 */
  maxDepth: number
}

export const TREE_LIMITS: TreeLimits = { maxFiles: 5000, maxBytes: 50 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024, maxDepth: 32 }

export type WalkError = 'symlink' | 'bad_file_type' | 'too_many_files' | 'too_large' | 'file_too_large' | 'too_deep' | 'bad_path'
export type TreeErrorCode = WalkError | 'changed'

export type WalkResult = { ok: true; files: TreeFile[]; bytes: number } | { ok: false; error: WalkError; path?: string }

/** copyTree、integrityOf 拒绝时抛它;code 是稳定代码,path 已清理 */
export class TreeError extends Error {
  constructor(
    readonly code: TreeErrorCode,
    readonly path?: string,
  ) {
    super(path === undefined ? code : `${code}: ${path}`)
  }
}
TreeError.prototype.name = 'TreeError'

const O_NONBLOCK = constants.O_NONBLOCK ?? 0
const PATH_SHOWN_MAX = 300
/** 目录不算文件,但一堆空目录也得有头 */
const ENTRIES_PER_FILE = 4
const CHUNK = 64 * 1024

const isGit = (name: string) => name.toLowerCase() === '.git'

/** 路径段不合规:控制字符、不可见的格式字符(方向覆盖、零宽)、行和段分隔符、反斜杠 */
export const badSegment = (name: string) => name === '' || name === '.' || name === '..' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\/]/u.test(name)

/** 给人看的路径:控制、格式、行段分隔字符写成 \uXXXX,截断 */
export const cleanPath = (p: string) => clip(p.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`), PATH_SHOWN_MAX)

interface Walked extends TreeFile {
  dev: number
  ino: number
}
type Scan = { ok: true; files: Walked[]; dirs: string[]; bytes: number } | { ok: false; error: WalkError; path?: string }

function scan(root: string, partial: Partial<TreeLimits> | undefined, exclude: ReadonlySet<string>): Scan {
  const limits = { ...TREE_LIMITS, ...partial }
  const maxEntries = limits.maxFiles * ENTRIES_PER_FILE
  const files: Walked[] = []
  const dirs: string[] = []
  let bytes = 0
  let entries = 0
  const fail = (error: WalkError, path?: string): Scan => ({ ok: false, error, ...(path !== undefined && { path: cleanPath(path) }) })

  const visit = (abs: string, rel: string, depth: number): Scan | undefined => {
    let names: Buffer[]
    try {
      names = readdirSync(abs, { encoding: 'buffer' })
    } catch {
      return fail('bad_path', rel)
    }
    if (names.length > maxEntries) return fail('too_many_files', rel)
    names.sort(Buffer.compare)
    for (const raw of names) {
      const name = raw.toString('utf8')
      if (isGit(name) || exclude.has(name)) continue
      const path = rel === '' ? name : `${rel}/${name}`
      if (!Buffer.from(name, 'utf8').equals(raw) || badSegment(name)) return fail('bad_path', path)
      if (++entries > maxEntries) return fail('too_many_files')
      if (depth + 1 > limits.maxDepth) return fail('too_deep', path)
      const child = join(abs, name)
      let st: Stats
      try {
        st = lstatSync(child)
      } catch {
        return fail('bad_path', path)
      }
      if (st.isSymbolicLink()) return fail('symlink', path)
      if (st.isDirectory()) {
        dirs.push(path)
        const failed = visit(child, path, depth + 1)
        if (failed) return failed
        continue
      }
      // 硬链接可能是别人的文件,内容一样会被拷进来
      if (!st.isFile() || st.nlink > 1) return fail('bad_file_type', path)
      if (st.size > limits.maxFileBytes) return fail('file_too_large', path)
      if (files.length + 1 > limits.maxFiles) return fail('too_many_files')
      bytes += st.size
      if (bytes > limits.maxBytes) return fail('too_large')
      files.push({ path, size: st.size, exec: (st.mode & 0o111) !== 0, dev: st.dev, ino: st.ino })
    }
    return undefined
  }

  let st: Stats
  try {
    st = lstatSync(root)
  } catch {
    return fail('bad_path')
  }
  if (st.isSymbolicLink()) return fail('symlink')
  if (!st.isDirectory()) return fail('bad_file_type')
  const failed = visit(root, '', 0)
  if (failed) return failed
  files.sort((a, b) => order(a.path, b.path))
  return { ok: true, files, dirs, bytes }
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** `.git`(任何深度,任何大小写,目录或文件)不走不计 */
export function walkTree(root: string, limits?: Partial<TreeLimits>): WalkResult {
  const r = scan(root, limits, new Set())
  if (!r.ok) return r
  return { ok: true, bytes: r.bytes, files: r.files.map(({ path, size, exec }) => ({ path, size, exec })) }
}

/**
 * 不跟随地打开一个已遍历过的文件。O_NOFOLLOW 只管末段,所以打开之后再看一遍每一级父目录:
 * 目录被换成链接时,打开的就是别处的文件。先检查再打开有窗口,先打开再检查没有;换过去又马上换回来的挡不住
 */
function openPlain(root: string, rel: string): { fd: number; st: Stats } {
  const abs = join(root, rel)
  let fd: number
  try {
    fd = openSync(abs, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new TreeError(code === 'ELOOP' || code === 'EMLINK' || code === 'ENOTDIR' ? 'symlink' : 'changed', cleanPath(rel))
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink > 1) throw new TreeError('bad_file_type', cleanPath(rel))
    const segs = rel.split('/').slice(0, -1)
    for (let i = 1; i <= segs.length; i++) {
      const dir = segs.slice(0, i).join('/')
      if (!lstatSync(join(root, dir)).isDirectory()) throw new TreeError('symlink', cleanPath(dir))
    }
    return { fd, st }
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

export type PlainRead = { ok: true; bytes: Buffer } | { ok: false; error: 'not_found' | 'symlink' | 'bad_file_type' | 'too_large' }

/** 读一个根内的文件:同样不跟随。超过 max 字节回 too_large,不多读。rel 是调用方查过的相对路径 */
export function readPlain(root: string, rel: string, max: number): PlainRead {
  let opened: { fd: number }
  try {
    opened = openPlain(root, rel)
  } catch (e) {
    const code = e instanceof TreeError ? e.code : undefined
    if (code === 'symlink' || code === 'bad_file_type') return { ok: false, error: code }
    return { ok: false, error: 'not_found' }
  }
  const { fd } = opened
  try {
    const buf = Buffer.allocUnsafe(max + 1)
    // 不信 fstat 的大小,它之后还可能变:读到上限加一就够判断了
    let len = 0
    while (len <= max) {
      const n = readSync(fd, buf, len, buf.length - len, null)
      if (n === 0) break
      len += n
    }
    return len > max ? { ok: false, error: 'too_large' } : { ok: true, bytes: buf.subarray(0, len) }
  } finally {
    closeSync(fd)
  }
}

/** `sha256:<hex>`:排序后的 (路径, 是否可执行, 内容 sha256)。可执行位和内容取自同一个 fd,不看传进来的 exec。链接换进来 → TreeError */
export function integrityOf(root: string, files: readonly TreeFile[]): string {
  const all = createHash('sha256')
  const buf = Buffer.allocUnsafe(CHUNK)
  for (const path of files.map(f => f.path).sort(order)) {
    const { fd, st } = openPlain(root, path)
    try {
      const one = createHash('sha256')
      for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) one.update(buf.subarray(0, n))
      all.update(`${JSON.stringify([path, (st.mode & 0o111) !== 0, one.digest('hex')])}\n`)
    } finally {
      closeSync(fd)
    }
  }
  return `sha256:${all.digest('hex')}`
}

export interface CopyOpts {
  /** 任何深度按名字跳过。`.git` 总是跳过 */
  exclude?: string[]
  limits?: Partial<TreeLimits>
  /** 只给测试:每个文件打开之前调一次,在这里换文件 */
  beforeOpen?: (rel: string) => void
  /** 只给测试:每个目录建之前调一次 */
  beforeMkdir?: (rel: string) => void
}

function freshDir(to: string): void {
  let st: Stats
  try {
    st = lstatSync(to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    mkdirSync(to, { recursive: true, mode: 0o755 })
    return
  }
  if (st.isSymbolicLink()) throw new TreeError('symlink')
  if (!st.isDirectory() || readdirSync(to).length > 0) throw new TreeError('bad_path')
}

/** 目标里已有这一项:Foo 和 foo 拷到不分大小写的卷上会撞。报相对路径,不带暂存区的绝对路径 */
function exclusive<T>(rel: string, create: () => T): T {
  try {
    return create()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new TreeError('bad_path', cleanPath(rel))
    throw e
  }
}

function copyOne(from: string, to: string, f: Walked, buf: Buffer, beforeOpen?: (rel: string) => void): void {
  beforeOpen?.(f.path)
  const { fd, st } = openPlain(from, f.path)
  try {
    // 和遍历时不是同一个文件:同意的是遍历看到的那棵树
    if (st.dev !== f.dev || st.ino !== f.ino || st.size !== f.size) throw new TreeError('changed', cleanPath(f.path))
    const out = exclusive(f.path, () => openSync(join(to, f.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600))
    try {
      let copied = 0
      for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) {
        copied += n
        if (copied > f.size) throw new TreeError('changed', cleanPath(f.path))
        writeSync(out, buf, 0, n)
      }
      if (copied !== f.size) throw new TreeError('changed', cleanPath(f.path))
      // 不留属主、setuid、别人的组写:只有这两种模式,也不看 umask
      fchmodSync(out, (st.mode & 0o111) !== 0 ? 0o755 : 0o644)
    } finally {
      closeSync(out)
    }
  } finally {
    closeSync(fd)
  }
}

/** 普通拷贝,不调 git。失败抛 TreeError 并删掉 to;to 已有内容或是链接时不碰它 */
export function copyTree(from: string, to: string, o: CopyOpts = {}): void {
  const r = scan(from, o.limits, new Set(o.exclude ?? []))
  if (!r.ok) throw new TreeError(r.error, r.path)
  freshDir(to)
  try {
    for (const d of r.dirs) {
      o.beforeMkdir?.(d)
      exclusive(d, () => mkdirSync(join(to, d), { mode: 0o755 }))
    }
    const buf = Buffer.allocUnsafe(CHUNK)
    for (const f of r.files) copyOne(from, to, f, buf, o.beforeOpen)
  } catch (e) {
    rmSync(to, { recursive: true, force: true })
    throw e
  }
}
