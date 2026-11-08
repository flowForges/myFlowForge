// 目录占的字节数(08 §4.4,worktree 列表用):lstat,不跟链接(链接只算它自己);项数超上限、根不是目录 → undefined。
// 一棵 5 万项的树同步走要几百毫秒,十来棵就能让工作进程被看门狗杀掉(review I4):每 yieldEvery 项让出一次事件循环,
// 结果按路径和根目录的 mtime 缓存一分钟
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TTL_MS = 60_000
const cache = new Map<string, { mtimeMs: number; at: number; bytes: number | undefined }>()

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

export async function dirSize(root: string, o: { maxEntries?: number; yieldEvery?: number } = {}): Promise<number | undefined> {
  const max = o.maxEntries ?? 50_000
  const every = o.yieldEvery ?? 500
  let mtimeMs: number
  try {
    const st = lstatSync(root)
    if (!st.isDirectory()) return undefined
    mtimeMs = st.mtimeMs
  } catch {
    return undefined
  }
  const key = `${max}\0${root}`
  const hit = cache.get(key)
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < TTL_MS) return hit.bytes
  const bytes = await walk(root, max, every)
  cache.set(key, { mtimeMs, at: Date.now(), bytes })
  if (cache.size > 1000) cache.delete(cache.keys().next().value!)
  return bytes
}

async function walk(root: string, max: number, every: number): Promise<number | undefined> {
  let total = 0
  let entries = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue // 看不了的子目录不算
    }
    for (const name of names) {
      if (++entries > max) return undefined
      if (entries % every === 0) await tick()
      const p = join(dir, name)
      try {
        const st = lstatSync(p)
        if (st.isDirectory()) stack.push(p)
        else total += st.size
      } catch {
        // 列出之后被删了
      }
    }
  }
  return total
}
