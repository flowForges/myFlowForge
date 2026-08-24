import type { TreeNode } from '../../../src/shared/types'

/**
 * 服务端文件浏览的**纯逻辑**:把 `fs:tree` 返回的那棵嵌套 `TreeNode[]` 变成
 * 「当前在哪个目录、这一屏该列哪些条目」。
 *
 * ★为什么不在手机上做成一棵可展开的树:390px 宽,每往下一层缩进就少一截可读宽度,
 *  三层之后文件名只剩几个字。**一次只列一层 + 面包屑**在手机上才读得下去 ——
 *  原型 `files.html` 的 `.crumb` + `.fitem` 就是这么做的。
 */

export type Entry = {
  type: 'dir' | 'file'
  name: string
  /** 相对 cwd 的路径,和 `TreeNode.path` 同一套。 */
  path: string
  /** 目录:里面有几项。文件:undefined。 */
  count?: number
  /** git 改动标记,`fs:tree` 已经标好了,原样带出来。 */
  chg?: TreeNode['chg']
  /** 这个目录是一个 git 仓库时的当前分支。 */
  branch?: string
}

/** 面包屑的一段。`path` 传给 `listDir` 就能跳回去。 */
export type Crumb = { name: string; path: string }

/** 在树里按相对路径找到那个目录的 children。根目录传 ''。 */
function childrenAt(tree: TreeNode[], dir: string): TreeNode[] | null {
  if (!dir) return tree
  let level: TreeNode[] | undefined = tree
  for (const seg of dir.split('/').filter(Boolean)) {
    const hit: TreeNode | undefined = level?.find((n) => n.type === 'dir' && n.name === seg)
    if (!hit) return null
    level = hit.children ?? []
  }
  return level ?? []
}

/**
 * 列出 `dir` 这一层。**目录在前、文件在后,各自按名字排** —— 服务端给的顺序是
 * `git ls-files` 的顺序,不是给人看的。
 */
export function listDir(tree: TreeNode[], dir: string): Entry[] | null {
  const kids = childrenAt(tree, dir)
  if (!kids) return null
  const out: Entry[] = kids.map((n) => ({
    type: n.type,
    name: n.name,
    path: n.path,
    count: n.type === 'dir' ? (n.children?.length ?? 0) : undefined,
    chg: n.chg,
    branch: n.branch,
  }))
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
}

/** 面包屑。第一段是项目本身(根),后面每一段都能点回去。 */
export function crumbs(root: string, dir: string): Crumb[] {
  const out: Crumb[] = [{ name: root, path: '' }]
  const segs = dir.split('/').filter(Boolean)
  let acc = ''
  for (const s of segs) {
    acc = acc ? `${acc}/${s}` : s
    out.push({ name: s, path: acc })
  }
  return out
}

/** 上一层的路径。已经在根就返回 null(界面据此不画「..」)。 */
export function parentOf(dir: string): string | null {
  if (!dir) return null
  const i = dir.lastIndexOf('/')
  return i < 0 ? '' : dir.slice(0, i)
}

/** 按文件名过滤这一层(原型 `files.html` 的「按文件名过滤…」)。空串 = 不过滤。 */
export function filterEntries(entries: Entry[], q: string): Entry[] {
  const t = q.trim().toLowerCase()
  if (!t) return entries
  return entries.filter((e) => e.name.toLowerCase().includes(t))
}

/** 一个文件最多显示多少行。超过就截断,**并且说出来**。 */
export const FILE_LINE_CAP = 800

export type NumberedLine = { ln: number; text: string }
export type FileView = { lines: NumberedLine[]; total: number; dropped: number }

/**
 * 把文件正文切成带行号的行。
 *
 * ★超出上限一定要**如实说**(界面上写「只显示前 N 行,还有 M 行没显示」)。
 *  静默截到 800 行,人看到最后一行就以为文件到此为止 —— 而这一屏正是他用来判断
 *  「敢不敢让代理继续」的依据。
 */
export function numberLines(text: string, cap = FILE_LINE_CAP): FileView {
  // 空文件是**零行**,不是一行空的 —— `''.split('\n')` 给的是 `['']`,照单全收就会画出一行
  // 空行号,看起来像「这个文件有一行,内容是空的」。
  if (!text) return { lines: [], total: 0, dropped: 0 }
  const all = text.replace(/\n$/, '').split('\n')
  const kept = all.slice(0, cap)
  return {
    lines: kept.map((t, i) => ({ ln: i + 1, text: t })),
    total: all.length,
    dropped: all.length - kept.length,
  }
}
