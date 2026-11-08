// 目录占的字节数(08 §4.4,worktree 列表用):lstat,不跟链接(链接只算它自己);项数超上限、根不是目录 → undefined
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function dirSize(root: string, o: { maxEntries?: number } = {}): number | undefined {
  const max = o.maxEntries ?? 50_000
  try {
    if (!lstatSync(root).isDirectory()) return undefined
  } catch {
    return undefined
  }
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
