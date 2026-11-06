// 删一棵可能被它的主人锁过的树(09 Task 9 I3):服务能在自己的数据目录里 chflags uchg、chmod 000,不能因此留下东西。
// 先正常删;删不掉才一层层 lstat:清标志和 ACL、恢复目录权限,再删。链接只摘链接本身,不改也不穿过它的目标。
// ACL(final review I-3):沙箱里 `chmod +a "everyone deny delete"` 一样能把自己的数据目录钉住
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const CHFLAGS = '/usr/bin/chflags'
const CHMOD = '/bin/chmod'
const CHUNK = 256

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function run(bin: string, flags: string[], paths: string[]): void {
  for (let i = 0; i < paths.length; i += CHUNK) spawnSync(bin, [...flags, ...paths.slice(i, i + CHUNK)], { stdio: 'ignore', timeout: 5000 })
}

function clearFlags(paths: string[]): void {
  if (process.platform !== 'darwin') return // Linux 上的 chattr +i 要 root,ACL 也不挡主人删:服务做不到
  // -h:是链接就动链接本身。路径都是绝对的,不会被当成选项。清不掉(root 的 schg)就留给后面的删除去失败
  run(CHFLAGS, ['-h', 'nouchg,nouappnd'], paths)
  // -N 去掉整条 ACL。`-h -N` 要先打开文件,deny list 的目录打不开,所以只给链接用;别的刚 lstat 过不是链接,主人已经停了,没人来换
  const links = new Set(paths.filter(isLink))
  run(CHMOD, ['-N'], paths.filter(p => !links.has(p)))
  run(CHMOD, ['-h', '-N'], [...links])
}

const isGone = (p: string): boolean => {
  try {
    lstatSync(p)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function loosen(top: string): void {
  clearFlags([top])
  const stack = [top]
  while (stack.length > 0) {
    const dir = stack.pop()!
    try {
      if (!lstatSync(dir).isDirectory()) continue
      chmodSync(dir, 0o700) // 上一行 lstat 过:是真目录。主人此时已经停了,没人来换
      const names = readdirSync(dir).map(n => join(dir, n))
      clearFlags(names)
      stack.push(...names)
    } catch {
      // 这一支动不了:最后的删除会失败,由调用方报
    }
  }
}

/** 删掉了或本来就没有:true。不抛错 */
export function removeTree(top: string): boolean {
  try {
    rmSync(top, { recursive: true, force: true })
    if (isGone(top)) return true
  } catch {
    // 下面松开再试
  }
  loosen(top)
  try {
    rmSync(top, { recursive: true, force: true })
  } catch {
    return false
  }
  return isGone(top)
}
