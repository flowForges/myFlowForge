import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './gitRunner'
import type { ChangeItem, ChangeType, MultiChanges } from '@shared/types'
export type { MultiChanges }

export async function readChanges(cwd: string, proxy = ''): Promise<ChangeItem[]> {
  let status: string
  try { status = await git(['status', '--porcelain'], { cwd, proxy }) } catch { return [] }
  const lines = status.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return []

  // numstat for tracked (staged or unstaged) changes vs HEAD
  let numstat = ''
  try { numstat = await git(['diff', '--numstat', 'HEAD'], { cwd, proxy }) } catch { numstat = '' }
  const stat = new Map<string, { add: number; del: number }>()
  for (const l of numstat.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = l.split('\t')
    stat.set(rest.join('\t'), { add: a === '-' ? 0 : Number(a), del: d === '-' ? 0 : Number(d) })
  }

  const items: ChangeItem[] = []
  for (const line of lines) {
    const x = line[0], y = line[1]
    const path = line.slice(3)
    let type: ChangeType
    if (x === '?' && y === '?') type = 'A'
    else if (x === 'A') type = 'A'
    else if (x === 'D' || y === 'D') type = 'D'
    else type = 'M'
    let add = 0, del = 0
    const ns = stat.get(path)
    if (ns) { add = ns.add; del = ns.del }
    else if (type === 'A') {
      try {
        const text = readFileSync(join(cwd, path), 'utf8')
        add = text.length ? text.replace(/\n$/, '').split('\n').length : 0
      } catch { add = 0 }
    }
    items.push({ path, type, add, del })
  }
  return items.sort((a, b) => a.path.localeCompare(b.path))
}

// Aggregate git changes across multiple project cwds. A cwd whose git call throws
// (non-git / missing dir) is skipped — it contributes an empty list, not an error.
// Return shape is flat + serializable for crossing the IPC / ChatMessage boundary.
// (MultiChanges lives in @shared/types so main and renderer agree.)
export async function readChangesMulti(cwds: string[], proxy = ''): Promise<MultiChanges> {
  const byProject = await Promise.all(
    cwds.map(async cwd => ({ cwd, changes: await readChanges(cwd, proxy).catch(() => [] as ChangeItem[]) }))
  )
  const all = byProject.flatMap(p => p.changes)
  return {
    total: all.length,
    add: all.reduce((n, c) => n + c.add, 0),
    del: all.reduce((n, c) => n + c.del, 0),
    byProject,
  }
}
