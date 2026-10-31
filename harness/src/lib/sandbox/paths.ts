// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// Seatbelt 与 bwrap 共用的路径校验与 realpath 拼写。
import { existsSync, realpathSync } from 'node:fs'
import { posix } from 'node:path'

const UNSAFE = /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** 校验并规范化:必须是绝对路径;去掉 . 段、重复与结尾斜杠。
 *  含 C0 控制字符、DEL、孤立代理项 → 抛错。
 *  `..` 段直接拒:按字面折叠会越过符号链接,规则落在错的目录上;调用方传解析好的路径 */
export function cleanPath(p: string, who: string): string {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error(`${who}: path must be absolute: ${JSON.stringify(p)}`)
  if (UNSAFE.test(p)) throw new Error(`${who}: path contains control characters: ${JSON.stringify(p)}`)
  if (p.split('/').includes('..')) throw new Error(`${who}: path must not contain '..': ${JSON.stringify(p)}`)
  const n = posix.normalize(p)
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n
}

/** realpath 拼写;不存在时取最深的存在祖先的 realpath 再接上尾巴 */
export function realSpelling(p: string): string {
  const tail: string[] = []
  let cur = p
  for (;;) {
    if (existsSync(cur)) {
      try {
        const r = realpathSync.native(cur)
        return tail.length ? posix.join(r, ...tail.reverse()) : r
      } catch { return p }
    }
    const parent = posix.dirname(cur)
    if (parent === cur) return p
    tail.push(posix.basename(cur))
    cur = parent
  }
}

/** a 等于 root 或在 root 之下(两者都已 cleanPath) */
export function within(a: string, root: string): boolean {
  return a === root || root === '/' || a.startsWith(`${root}/`)
}
