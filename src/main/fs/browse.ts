import { readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, sep } from 'node:path'

export type BrowseEntry = { name: string; path: string; dir: boolean }
export type BrowseResult = {
  path: string
  /** 上一层;已经在根上时为 null */
  parent: string | null
  entries: BrowseEntry[]
  /** 这个目录本身是不是一个 myFlowForge 工作区(有 .forge/workspace.json) */
  isWorkspace: boolean
  error?: string
}

/**
 * 只读目录浏览 —— 「手机上怎么选目录」那个难点的落地(设计文档 14.7 第 2 难)。
 *
 * ★范围被刻意压到最小:**列目录、进下一层、返回上一层、选中**。不是文件管理器 ——
 * 不能改名、不能删除、不能写。多一个能写的口子,就多一条从网络到文件系统的路径。
 *
 * 只有三个入口真需要它(`dialogPickDirectory` / `dialogPickFile` / `workspacesOpenDir`),
 * 而且都是「在 host 上定位一个**已存在的**目录/可执行文件」。
 */
export function listDir(target: string, opts: { showHidden?: boolean; filesToo?: boolean } = {}): BrowseResult {
  const path = target && target.trim() ? target : homedir()
  const parent = parentOf(path)
  if (!existsSync(path)) return { path, parent, entries: [], isWorkspace: false, error: '这个目录不存在' }

  let names: string[]
  try { names = readdirSync(path) }
  catch (e) {
    // 没权限是常态(比如 /root、别的用户的目录)。回一句人话,不要抛 —— 抛出去在远程那头
    // 就变成一条 res(ok:false),界面上是红字报错,而这只是「这个目录你看不了」。
    return { path, parent, entries: [], isWorkspace: false, error: e instanceof Error ? e.message : '读不了这个目录' }
  }

  const entries: BrowseEntry[] = []
  for (const name of names) {
    if (!opts.showHidden && name.startsWith('.')) continue
    const full = join(path, name)
    let dir = false
    // 单个条目 stat 失败(坏软链、竞态删除)只该跳过它,不该让整个目录列不出来。
    try { dir = statSync(full).isDirectory() } catch { continue }
    if (!dir && !opts.filesToo) continue
    entries.push({ name, path: full, dir })
  }
  // 目录在前,再按名字排(localeCompare 让中文目录也排得像样)
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1))

  return { path, parent, entries, isWorkspace: existsSync(join(path, '.forge', 'workspace.json')) }
}

/** 已经在根上时没有上一层。`dirname('/')` 返回 '/',直接用会造出一个点不动的「返回」。 */
export function parentOf(path: string): string | null {
  const p = dirname(path)
  if (p === path) return null
  // Windows: `C:\` 的 dirname 还是 `C:\`,上面那条已经挡住;这里再挡一次盘符根。
  if (parse(path).root === path) return null
  return p
}

/** 起点:家目录优先,再给几个常见的。不存在的不列 —— 列一个点进去就报错的入口是纯添乱。 */
export function defaultRoots(): BrowseEntry[] {
  const home = homedir()
  const cands = [
    { name: '主目录', path: home },
    { name: '桌面', path: join(home, 'Desktop') },
    { name: '文稿', path: join(home, 'Documents') },
    { name: '根目录', path: sep === '\\' ? parse(home).root : '/' },
  ]
  return cands.filter((c) => { try { return existsSync(c.path) } catch { return false } })
    .map((c) => ({ ...c, dir: true }))
}
