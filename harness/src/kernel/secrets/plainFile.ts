import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const posix = process.platform !== 'win32'

/** 目录 0700(宽松则修正) */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (posix && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

/** 临时文件 + rename,0600 */
export function writePrivate(file: string, content: string): void {
  ensurePrivateDir(dirname(file))
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** 读取;权限位 `& 0o077` 宽松则修正为 0600。不存在返回 undefined */
export function readPrivate(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  if (posix && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
  return readFileSync(file, 'utf8')
}

export function parseMap(text: string): Record<string, string> {
  const v: unknown = JSON.parse(text)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a map')
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
  return out
}
