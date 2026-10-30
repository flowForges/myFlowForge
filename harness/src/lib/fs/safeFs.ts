// 不跟随链接的文件操作(编码工具与快照回滚共用):
// - 打开文件一律 O_NOFOLLOW(平台支持时),末段在检查后被换成符号链接 → 打开失败;
// - 建父目录逐级来,每建一级都 realpath 核对
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { isInside } from './paths'

/** Windows 没有 O_NOFOLLOW → 0(只剩执行前的再解析核对) */
export const O_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0

/** 同一路径(darwin / win32 不区分大小写,与权限门同一套比较) */
export const samePath = (a: string, b: string) => isInside(a, b, process.platform) && isInside(b, a, process.platform)

/** 路径项本身是否存在(不跟随链接);只有 ENOENT / ENOTDIR 算不存在,其他错误抛出 */
export const lexists = (p: string) => {
  try {
    lstatSync(p)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw e
  }
}

export const changed = (p: string) => new Error(`路径在权限检查之后发生了变化,未执行:${p}`)

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

/** 末段若存在就移走:文件 / 链接 unlink(不跟随),目录只删空的(非空 → 抛错) */
export function removeLeaf(p: string): void {
  let st
  try {
    st = lstatSync(p)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw e
  }
  if (st.isDirectory()) rmdirSync(p)
  else unlinkSync(p)
}

/**
 * 以新文件替换末段:先移走原来的(链接、FIFO、多硬链接文件都不会被写穿),
 * 再 O_CREAT | O_EXCL | O_NOFOLLOW 新建并写入;exec → 0o755。父目录须由调用方核对过
 */
export function replaceFile(p: string, data: Buffer, exec: boolean): void {
  removeLeaf(p)
  const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o666)
  try {
    let off = 0
    while (off < data.length) off += writeSync(fd, data, off, data.length - off)
    if (exec) fchmodSync(fd, 0o755)
  } finally {
    closeSync(fd)
  }
}

/** 以符号链接替换末段(链接本身不跟随);父目录须由调用方核对过 */
export function replaceSymlink(p: string, target: string): void {
  removeLeaf(p)
  symlinkSync(target, p)
}
