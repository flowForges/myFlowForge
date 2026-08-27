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

// ── 文件类型 ────────────────────────────────────────────────────────────────
// 用户看着文件列表说「感觉很素」:一屏几十行,前面全是同一个 `·`,名字全是同一个颜色同一个字重,
// 要找 `package.json` 只能一行一行读过去。电脑端(`views/inspector/fileIcon.tsx`)的解法是按扩展名
// 给一枚彩色徽章 —— 但手机端有一条更硬的规矩:**实底彩色块全屏只留给权限门**(原型 d.css 第三条原则)。
// 所以这里只做分类,颜色由界面按「淡色文字 + 字重」落地,不画色块。

/** 文件的大类。只有 6 类 —— 分得再细,390px 宽的一列上人也读不出差别。 */
export type FileKind = 'code' | 'markup' | 'data' | 'doc' | 'media' | 'other'

/** 小写扩展名(不含点)。没有扩展名返回 ''。 */
export function extOf(name: string): string {
  // ★只认**最后一段**,而且必须是字母数字:`.gitignore` 这种整名就是个「点开头」的文件,
  //  切出来的 `gitignore` 当扩展名会让它显示成一枚 8 个字母的怪徽章;`v1.2.3-notes` 同理。
  const m = /[^.\/]\.([a-z0-9]+)$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

const KIND: Record<string, FileKind> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', py: 'code', go: 'code',
  rs: 'code', java: 'code', kt: 'code', swift: 'code', c: 'code', h: 'code', cpp: 'code', hpp: 'code',
  cs: 'code', rb: 'code', php: 'code', sh: 'code', bash: 'code', zsh: 'code', sql: 'code', lua: 'code',
  dart: 'code', scala: 'code', ex: 'code', exs: 'code', mm: 'code', m: 'code',
  html: 'markup', htm: 'markup', xml: 'markup', vue: 'markup', svelte: 'markup', css: 'markup',
  scss: 'markup', sass: 'markup', less: 'markup',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', ini: 'data', cfg: 'data', conf: 'data',
  env: 'data', lock: 'data', csv: 'data', tsv: 'data', plist: 'data',
  md: 'doc', markdown: 'doc', txt: 'doc', rst: 'doc', pdf: 'doc', adoc: 'doc', log: 'doc',
  png: 'media', jpg: 'media', jpeg: 'media', gif: 'media', webp: 'media', svg: 'media', ico: 'media',
  bmp: 'media', mp3: 'media', mp4: 'media', mov: 'media', wav: 'media', ttf: 'media', otf: 'media',
  woff: 'media', woff2: 'media',
}

/** 按名字判大类。认不出的一律 'other' —— 宁可不上色,也别把 `.bak` 说成代码。 */
export function fileKind(name: string): FileKind {
  return KIND[extOf(name)] ?? 'other'
}

/**
 * 列表里那一枚扩展名小标签的文字。
 *
 * ★截到 4 个字符:`woff2` / `markdown` 这种长扩展名会把名字那一列挤窄,而这一列的**主角是文件名**。
 * ★没有扩展名的(README、Makefile、.gitignore)给一个 `·` 占位 —— 留空的话这一列会忽宽忽窄,
 *  一屏扫下去名字左边缘对不齐,比没有徽章还乱。
 */
export function extBadge(name: string): string {
  const e = extOf(name)
  return e ? e.slice(0, 4) : '·'
}

/**
 * 这个文件该按哪种语言着色。
 *
 * ★服务端 `git:file` 返回的 `lang` 只认十来种扩展名(见 `src/main/git/diff.ts` 的 `EXT_LANG`),
 *  认不出时给的是字符串 `'text'` —— 而 `'text'` 在 `@shared/highlight` 的语言表里**不存在**,
 *  照着传过去就是整屏一个色。可 `@shared/highlight` 自己认得的语言(rs / java / rb / toml / dockerfile…)
 *  比那张表多得多。所以:服务端说得出来的就听它的,说 'text' 的**退回按扩展名再试一次**,
 *  两边都不认才是真的不着色。
 * ★diff 那半屏根本拿不到 `lang`(`git:diff` 只回行),走的就是扩展名这条路。
 */
export function langOf(file: string, serverLang?: string): string {
  if (serverLang && serverLang !== 'text') return serverLang
  return extOf(file)
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
