import { describe, it, expect } from 'vitest'
import type { TreeNode } from '../../../src/shared/types'
import { FILE_LINE_CAP, crumbs, extBadge, extOf, fileKind, filterEntries, langOf, listDir, numberLines, parentOf } from './fileTree'

// `fs:tree` 真实返回的形状(见 src/main/fs/fileTree.ts 的 buildTree):嵌套的 dir/file,
// path 是相对 cwd 的,改动过的文件带 chg,git 仓库目录带 branch。
const tree: TreeNode[] = [
  {
    type: 'dir',
    name: 'src',
    path: 'src',
    children: [
      {
        type: 'dir',
        name: 'main',
        path: 'src/main',
        children: [
          { type: 'file', name: 'index.ts', path: 'src/main/index.ts' },
          { type: 'file', name: 'handlers.ts', path: 'src/main/handlers.ts', chg: 'M' },
        ],
      },
      { type: 'file', name: 'app.ts', path: 'src/app.ts' },
    ],
  },
  { type: 'file', name: 'README.md', path: 'README.md' },
  { type: 'dir', name: 'assets', path: 'assets', children: [], branch: 'main' },
]

describe('listDir', () => {
  it('根目录:目录在前、文件在后,各自按名字排', () => {
    const e = listDir(tree, '')!
    expect(e.map((x) => x.name)).toEqual(['assets', 'src', 'README.md'])
  })

  it('★顺序不是服务端给的那个 —— git ls-files 的顺序不是给人看的', () => {
    // 输入里 src 在 assets 前面、README.md 在 assets 前面。
    const e = listDir(tree, '')!
    expect(e[0].name).not.toBe('src')
    expect(e.map((x) => x.type)).toEqual(['dir', 'dir', 'file'])
  })

  it('往下钻一层', () => {
    expect(listDir(tree, 'src')!.map((x) => x.name)).toEqual(['main', 'app.ts'])
    expect(listDir(tree, 'src/main')!.map((x) => x.name)).toEqual(['handlers.ts', 'index.ts'])
  })

  it('目录带条目数,文件不带', () => {
    const e = listDir(tree, '')!
    expect(e.find((x) => x.name === 'src')!.count).toBe(2)
    expect(e.find((x) => x.name === 'README.md')!.count).toBeUndefined()
  })

  it('★改动标记原样带出来(服务端已经标好了,别在手机上重算一遍)', () => {
    expect(listDir(tree, 'src/main')!.find((x) => x.name === 'handlers.ts')!.chg).toBe('M')
  })

  it('分支名也带出来', () => {
    expect(listDir(tree, '')!.find((x) => x.name === 'assets')!.branch).toBe('main')
  })

  it('★路径不存在返回 null,不是空数组 —— 「空目录」和「找不到」是两回事', () => {
    expect(listDir(tree, 'src/nope')).toBeNull()
    expect(listDir(tree, 'assets')).toEqual([])
  })

  it('★同名文件不能被当成目录钻进去', () => {
    expect(listDir(tree, 'README.md')).toBeNull()
  })
})

describe('crumbs', () => {
  it('根只有项目名', () => {
    expect(crumbs('forge', '')).toEqual([{ name: 'forge', path: '' }])
  })
  it('每一段都能点回去', () => {
    expect(crumbs('forge', 'src/main')).toEqual([
      { name: 'forge', path: '' },
      { name: 'src', path: 'src' },
      { name: 'main', path: 'src/main' },
    ])
  })
})

describe('parentOf', () => {
  it('根没有上一层', () => {
    expect(parentOf('')).toBeNull()
  })
  it('一层深回到根(空串,不是 null)', () => {
    expect(parentOf('src')).toBe('')
  })
  it('深层回上一级', () => {
    expect(parentOf('src/main/ipc')).toBe('src/main')
  })
})

describe('filterEntries', () => {
  const e = listDir(tree, 'src/main')!
  it('空串不过滤', () => {
    expect(filterEntries(e, '  ')).toHaveLength(2)
  })
  it('大小写不敏感、按包含匹配', () => {
    expect(filterEntries(e, 'HAND').map((x) => x.name)).toEqual(['handlers.ts'])
  })
})

describe('numberLines', () => {
  it('从 1 开始编号', () => {
    const v = numberLines('a\nb\nc')
    expect(v.lines).toEqual([
      { ln: 1, text: 'a' },
      { ln: 2, text: 'b' },
      { ln: 3, text: 'c' },
    ])
    expect(v.dropped).toBe(0)
  })

  it('末尾那个换行不算一行', () => {
    expect(numberLines('a\nb\n').total).toBe(2)
  })

  it('★超出上限要截断,并且把丢了多少行说出来', () => {
    const text = Array.from({ length: FILE_LINE_CAP + 25 }, (_, i) => `L${i}`).join('\n')
    const v = numberLines(text)
    expect(v.lines).toHaveLength(FILE_LINE_CAP)
    expect(v.total).toBe(FILE_LINE_CAP + 25)
    expect(v.dropped).toBe(25)
    // 截断了也不能把行号重编 —— 第 800 行就得是 800
    expect(v.lines[FILE_LINE_CAP - 1].ln).toBe(FILE_LINE_CAP)
  })

  it('空文件是零行,不是一行空的', () => {
    expect(numberLines('')).toEqual({ lines: [], total: 0, dropped: 0 })
  })
})

describe('extOf / fileKind / extBadge', () => {
  it('取最后一段扩展名并转小写', () => {
    expect(extOf('App.TSX')).toBe('tsx')
    expect(extOf('a/b/c.min.js')).toBe('js')
  })

  it('★点开头的整名不是扩展名', () => {
    // `.gitignore` 切出 `gitignore` 会显示成一枚 8 个字母的怪徽章,把名字那一列挤没。
    expect(extOf('.gitignore')).toBe('')
    expect(extBadge('.gitignore')).toBe('·')
    expect(extOf('Makefile')).toBe('')
  })

  it('★带非字母数字的尾段不算扩展名', () => {
    expect(extOf('v1.2.3-notes')).toBe('')
  })

  it('分类覆盖六大类', () => {
    expect(fileKind('a.ts')).toBe('code')
    expect(fileKind('a.scss')).toBe('markup')
    expect(fileKind('a.yml')).toBe('data')
    expect(fileKind('a.md')).toBe('doc')
    expect(fileKind('a.woff2')).toBe('media')
    expect(fileKind('a.bak')).toBe('other')
    expect(fileKind('Makefile')).toBe('other')
  })

  it('★长扩展名截到 4 个字符,不然名字那一列被挤窄', () => {
    expect(extBadge('a.woff2')).toBe('woff')
    expect(extBadge('a.markdown')).toBe('mark')
  })
})

describe('langOf', () => {
  it('服务端说得出来的就听它的', () => {
    expect(langOf('a.tsx', 'tsx')).toBe('tsx')
  })

  it("★服务端给 'text' 时退回按扩展名再试 —— 那张表只认十来种,着色表认得多得多", () => {
    // `git:file` 的 EXT_LANG 里没有 rs/toml/rb,回的是 'text';而 @shared/highlight 三个都认。
    expect(langOf('main.rs', 'text')).toBe('rs')
    expect(langOf('Cargo.toml', 'text')).toBe('toml')
  })

  it('两边都不认才是真的不着色', () => {
    expect(langOf('notes', 'text')).toBe('')
  })

  it('★diff 那半屏拿不到 lang,只传文件名也要work', () => {
    expect(langOf('src/a.py')).toBe('py')
  })
})
