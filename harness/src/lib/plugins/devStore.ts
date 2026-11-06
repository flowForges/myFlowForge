// 开发插件的副本和记录(09 spec §12、M26)。确认时把 main 读一次:算哈希的字节就是落盘的字节,之后只加载这份。
// 模型能改用户项目里的文件,改不到数据目录,所以改了源文件不算数,要用户再确认一次
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { removeTree } from '../fs/removeTree'
import { parseNative } from './manifest'

export const MAX_DEV_MAIN_BYTES = 20 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_NONBLOCK = constants.O_NONBLOCK ?? 0
const DEV_ID_RE = /^dev-[a-z0-9-]{1,60}$/
const HASH_RE = /^[0-9a-f]{64}$/

export interface DevEntry {
  id: string
  hash: string
  /** 永远由 id 和 hash 算出来,不从记录里读 */
  file: string
  trustedAt: number
}

export type TrustError = 'not_found' | 'bad_manifest' | 'id_not_dev' | 'main_invalid' | 'symlink' | 'too_large' | 'store_error'
export type TrustResult = { ok: true; id: string; hash: string; bytes: number; main: string } | { ok: false; error: TrustError }

const devRoot = (dataDir: string) => join(dataDir, 'dev-plugins')
const indexFile = (dataDir: string) => join(devRoot(dataDir), 'index.json')
const copyName = (hash: string) => `entry-${hash.slice(0, 12)}.mjs`
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** 载开发插件的这次启动还没正常停:在就是上次崩了。工作进程的 run 目录里 */
export const DEV_LOADING = 'dev-loading'
/** 崩过一次就一直跳过,直到再确认或移除一个开发插件(final review):否则崩、跳、载、崩来回转 */
export const DEV_CRASHED = 'dev-crashed'
export const devRunDir = (dataDir: string) => join(dataDir, 'run')

/** 再确认、移除之后下次启动再试。删不掉只是还跳过,不算失败 */
function liftDevSkip(dataDir: string): void {
  try {
    rmSync(join(devRunDir(dataDir), DEV_CRASHED), { force: true, recursive: true })
  } catch {
    // run 不是目录:那条路本来就不载
  }
}

type Once = { ok: true; bytes: Buffer } | { ok: false; why: 'missing' | 'symlink' | 'not_file' | 'too_large' }

/**
 * 只开一次、只读一次。O_NOFOLLOW:最后一段是链接就 ELOOP;O_NONBLOCK:换成 FIFO 也不会卡在 open 上。
 * 读本身有上限,fstat 之后才长大的文件一样过不去
 */
export function readOnce(abs: string, cap: number, opened?: () => void): Once {
  let fd: number
  try {
    fd = openSync(abs, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { ok: false, why: code === 'ELOOP' ? 'symlink' : code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'not_file' }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { ok: false, why: 'not_file' }
    if (st.size > cap) return { ok: false, why: 'too_large' }
    opened?.()
    const chunks: Buffer[] = []
    let total = 0
    const buf = Buffer.allocUnsafe(65536)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      total += n
      if (total > cap) return { ok: false, why: 'too_large' }
      chunks.push(Buffer.from(buf.subarray(0, n)))
    }
    return { ok: true, bytes: Buffer.concat(chunks) }
  } catch {
    return { ok: false, why: 'not_file' }
  } finally {
    closeSync(fd)
  }
}

const validMain = (main: unknown): main is string =>
  typeof main === 'string' &&
  main.endsWith('.mjs') &&
  !main.startsWith('/') &&
  !/^[A-Za-z]:/.test(main) &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f\\]/.test(main) &&
  main.split('/').every(s => s !== '..')

/** main 这一路的每一段:链接不跟,目标在目录里面也不行。返回 null = 都是目录,最后是普通文件 */
function walkMain(root: string, main: string): 'symlink' | 'main_invalid' | null {
  const parts = main.split('/').filter(s => s !== '' && s !== '.')
  if (parts.length === 0) return 'main_invalid'
  let at = root
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i])
    let st
    try {
      st = lstatSync(at)
    } catch {
      return 'main_invalid'
    }
    if (st.isSymbolicLink()) return 'symlink'
    const last = i === parts.length - 1
    if (last ? !st.isFile() : !st.isDirectory()) return 'main_invalid'
  }
  return null
}

/** 同目录写临时文件再改名;失败不留东西 */
function writeAtomic(file: string, tmpDir: string, bytes: Buffer): void {
  const tmp = join(tmpDir, `.tmp-${randomBytes(8).toString('hex')}`)
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600)
  try {
    try {
      let off = 0
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** 建目录;那里已经是别的东西(种进来的链接)就抛错,不穿过去 */
function ownDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory()) throw new Error('not a directory')
}

function writeIndex(dataDir: string, entries: Omit<DevEntry, 'file'>[]): void {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  writeAtomic(indexFile(dataDir), devRoot(dataDir), Buffer.from(JSON.stringify({ entries: sorted.map(e => ({ id: e.id, hash: e.hash, trustedAt: e.trustedAt })) })))
}

export function trustDevPlugin(o: {
  dataDir: string
  path: string
  reservedIds: Set<string>
  now?: () => number
  /** main 所在的目录能不能用:根目录过了 validateCwd,`main` 还能指到它里面的 .ssh */
  refusePath?: (dir: string) => boolean
  /** 只给测试:在这几步之间动文件 */
  onStep?: (step: 'checked' | 'opened' | 'read') => void
}): TrustResult {
  const refuse = (error: TrustError): TrustResult => ({ ok: false, error })
  let root: string
  try {
    root = realpathSync.native(o.path)
    if (!lstatSync(root).isDirectory()) return refuse('not_found')
  } catch {
    return refuse('not_found')
  }

  const mf = readOnce(join(root, 'mff-plugin.json'), MAX_MANIFEST_BYTES)
  if (!mf.ok) return refuse(mf.why === 'symlink' ? 'symlink' : mf.why === 'missing' ? 'not_found' : 'bad_manifest')
  let json: unknown
  try {
    json = JSON.parse(mf.bytes.toString('utf8'))
  } catch {
    return refuse('bad_manifest')
  }
  const parsed = parseNative(json)
  if (!parsed.ok) return refuse('bad_manifest')
  const { id, main } = parsed.manifest
  if (!DEV_ID_RE.test(id) || o.reservedIds.has(id)) return refuse('id_not_dev')
  if (!validMain(main)) return refuse('main_invalid')
  const walked = walkMain(root, main)
  if (walked) return refuse(walked)
  const parts = main.split('/').filter(s => s !== '' && s !== '.')
  const abs = join(root, ...parts)
  if (o.refusePath?.(join(root, ...parts.slice(0, -1)))) return refuse('main_invalid')

  o.onStep?.('checked')
  const read = readOnce(abs, MAX_DEV_MAIN_BYTES, () => o.onStep?.('opened'))
  if (!read.ok) return refuse(read.why === 'symlink' ? 'symlink' : read.why === 'too_large' ? 'too_large' : 'main_invalid')
  o.onStep?.('read')
  const hash = sha256(read.bytes)

  const dir = join(devRoot(o.dataDir), id)
  const name = copyName(hash)
  try {
    const others = readDevIndex(o.dataDir).filter(e => e.id !== id)
    ownDir(devRoot(o.dataDir))
    ownDir(dir)
    writeAtomic(join(dir, name), dir, read.bytes)
    writeIndex(o.dataDir, [...others, { id, hash, trustedAt: (o.now ?? Date.now)() }])
    // 记录已经指向新的了:旧副本删不掉只是占地方,不算失败
    for (const f of readdirSync(dir)) if (f !== name) rmSync(join(dir, f), { force: true, recursive: true })
  } catch {
    return refuse('store_error')
  }
  liftDevSkip(o.dataDir)
  return { ok: true, id, hash, bytes: read.bytes.length, main }
}

/** 记录拿掉、副本删掉。这个插件的数据目录和 secret 留着:下次确认接着调试。返回副本是否删干净了 */
export function removeDevPlugin(o: { dataDir: string; id: string }): boolean {
  if (!DEV_ID_RE.test(o.id)) return true
  const entries = readDevIndex(o.dataDir)
  if (entries.some(e => e.id === o.id)) writeIndex(o.dataDir, entries.filter(e => e.id !== o.id))
  liftDevSkip(o.dataDir)
  return removeTree(join(devRoot(o.dataDir), o.id))
}

/** 坏记录 = 什么都不加载。不符合形状的条目丢掉,文件路径自己算 */
export function readDevIndex(dataDir: string, log?: { warn(m: string): void }): DevEntry[] {
  let text: string
  try {
    text = readFileSync(indexFile(dataDir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log?.warn('dev plugin record unreadable')
    return []
  }
  let raw: unknown
  try {
    raw = (JSON.parse(text) as { entries?: unknown } | null)?.entries
  } catch {
    log?.warn('dev plugin record corrupt')
    return []
  }
  if (!Array.isArray(raw)) {
    log?.warn('dev plugin record corrupt')
    return []
  }
  const out = new Map<string, DevEntry>()
  for (const e of raw as { id?: unknown; hash?: unknown; trustedAt?: unknown }[]) {
    if (typeof e !== 'object' || e === null) continue
    const { id, hash, trustedAt } = e
    if (typeof id !== 'string' || !DEV_ID_RE.test(id) || typeof hash !== 'string' || !HASH_RE.test(hash) || typeof trustedAt !== 'number') continue
    out.set(id, { id, hash, file: join(devRoot(dataDir), id, copyName(hash)), trustedAt })
  }
  return [...out.values()]
}
