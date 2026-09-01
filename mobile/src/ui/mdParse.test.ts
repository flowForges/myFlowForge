import { describe, it, expect } from 'vitest'
import { parseMarkdown } from './mdParse'
import type { HNode } from './htmlParse'

/** 一棵树里的纯文字(`<br>` 当换行)。断言「字都还在」用它。 */
const flat = (ns: HNode[]): string =>
  ns.map((n) => (n.t === 'text' ? n.text : n.tag === 'br' ? '\n' : flat(n.kids))).join('')

/** 顶层块的标签序列。 */
const tags = (ns: HNode[]): string[] => ns.map((n) => (n.t === 'el' ? n.tag : '#text'))

/** 深度优先找第一个某标签的元素。 */
function find(ns: HNode[], tag: string): Extract<HNode, { t: 'el' }> | null {
  for (const n of ns) {
    if (n.t !== 'el') continue
    if (n.tag === tag) return n
    const hit = find(n.kids, tag)
    if (hit) return hit
  }
  return null
}
/** 某标签的全部元素。 */
function all(ns: HNode[], tag: string): Extract<HNode, { t: 'el' }>[] {
  const out: Extract<HNode, { t: 'el' }>[] = []
  for (const n of ns) {
    if (n.t !== 'el') continue
    if (n.tag === tag) out.push(n)
    out.push(...all(n.kids, tag))
  }
  return out
}

describe('段落和换行', () => {
  it('一段普通文字就是一个 p', () => {
    const ns = parseMarkdown('就是一句话。')
    expect(tags(ns)).toEqual(['p'])
    expect(flat(ns)).toBe('就是一句话。')
  })

  it('空行分段', () => {
    expect(tags(parseMarkdown('第一段\n\n第二段'))).toEqual(['p', 'p'])
  })

  it('★段内单个换行保留成 br —— 代理很爱在一段里手动折行,吞掉的话两句话会挤成一句', () => {
    const ns = parseMarkdown('第一行\n第二行')
    expect(tags(ns)).toEqual(['p'])
    expect(flat(ns)).toBe('第一行\n第二行')
  })

  it('全是空白 → 什么块都不出', () => {
    expect(parseMarkdown('   \n\n  \n')).toEqual([])
  })
})

describe('行内', () => {
  it('粗体 / 斜体 / 行内代码', () => {
    const ns = parseMarkdown('这是 **粗** 和 *斜* 和 `代码`')
    expect(find(ns, 'strong')).toBeTruthy()
    expect(find(ns, 'em')).toBeTruthy()
    expect(flat(find(ns, 'code')!.kids)).toBe('代码')
  })

  it('__粗__ 和 _斜_ 也认', () => {
    const ns = parseMarkdown('__粗__ 与 _斜_')
    expect(flat(find(ns, 'strong')!.kids)).toBe('粗')
    expect(flat(find(ns, 'em')!.kids)).toBe('斜')
  })

  it('粗体里面还能有行内代码 —— 递归,不是只取纯文本', () => {
    const ns = parseMarkdown('**改 `foo.ts` 这个文件**')
    const s = find(ns, 'strong')!
    expect(find(s.kids, 'code')).toBeTruthy()
  })

  it('链接变成 a,href 带上', () => {
    const a = find(parseMarkdown('见 [文档](https://x.dev/a)'), 'a')!
    expect(a.href).toBe('https://x.dev/a')
    expect(flat(a.kids)).toBe('文档')
  })

  it('裸 URL 自动变可点的链接', () => {
    const a = find(parseMarkdown('打开 https://x.dev/a 看看'), 'a')!
    expect(a.href).toBe('https://x.dev/a')
  })

  it('★裸 URL 不吞后面紧贴的中文 —— 代理常写「打开https://x/然后…」', () => {
    const a = find(parseMarkdown('打开https://x.dev/a然后回来'), 'a')!
    expect(a.href).toBe('https://x.dev/a')
    expect(flat(parseMarkdown('打开https://x.dev/a然后回来'))).toContain('然后回来')
  })

  it('★裸 URL 末尾的句号属于句子,不属于地址', () => {
    expect(find(parseMarkdown('见 https://x.dev/a。'), 'a')!.href).toBe('https://x.dev/a')
    expect(find(parseMarkdown('见 https://x.dev/a.'), 'a')!.href).toBe('https://x.dev/a')
  })

  it('★★优先级由「谁先出现」决定,不由规则表的顺序决定:反引号里的 URL 不拆成链接', () => {
    const ns = parseMarkdown('跑 `curl https://x.dev/a` 一下')
    expect(find(ns, 'a')).toBeNull()
    expect(flat(find(ns, 'code')!.kids)).toBe('curl https://x.dev/a')
  })

  it('★★同理:`[文字](url)` 里链接从 `[` 命中,下标更小,所以整条是链接不是裸 URL', () => {
    const as = all(parseMarkdown('[文字](https://x.dev/a)'), 'a')
    expect(as).toHaveLength(1)
    expect(flat(as[0].kids)).toBe('文字')
  })

  it('★图片降级成链接,不联网 —— 手机端一个远程请求都不许发(同 htmlParse 禁 img)', () => {
    const ns = parseMarkdown('![架构图](https://x.dev/p.png)')
    const a = find(ns, 'a')!
    expect(a.href).toBe('https://x.dev/p.png')
    expect(flat(a.kids)).toContain('架构图')
  })

  it('★半截的 `**` 原样显示,不吞后文 —— 流式吐字时每一帧都是半截的', () => {
    expect(flat(parseMarkdown('前面 **还没写完'))).toBe('前面 **还没写完')
  })

  it('孤零零一个星号不算斜体', () => {
    expect(flat(parseMarkdown('2 * 3 = 6'))).toBe('2 * 3 = 6')
  })

  /**
   * ★★2026-09-01 截图上一眼看出来的:词**中间**的下划线不是强调标记。
   *  代理的回答里全是 `apply_status`、`ACTIVITY_END_STATUS` 这种蛇形命名 ——
   *  按「一对下划线=斜体」处理的话,`apply_status 仍 EFFECTIVE + 无 ACTIVITY_END` 会变成
   *  `apply` + 斜体`status 仍 EFFECTIVE + 无 ACTIVITY` + `END`:**下划线整个消失,还多了一片斜体**。
   *  GFM 就是这么规定的(`_` 不做词内强调,`*` 做),这里照办。
   */
  describe('词中间的下划线', () => {
    it('★蛇形命名原样保留,一个下划线都不许吃', () => {
      const src = 'apply_status 仍 EFFECTIVE + 无 ACTIVITY_END worker'
      expect(flat(parseMarkdown(src))).toBe(src)
      expect(find(parseMarkdown(src), 'em')).toBeNull()
    })

    it('★双下划线同理:`MAX__LEN` 里的那对不是粗体', () => {
      const src = '常量叫 MAX__LEN,别改'
      expect(flat(parseMarkdown(src))).toBe(src)
      expect(find(parseMarkdown(src), 'strong')).toBeNull()
    })

    it('★但两边都是空格的 `__init__` **确实**是粗体 —— CommonMark 和 GitHub 都这么渲染', () => {
      // 这条钉的是「不许自己发明规矩」:电脑端那份按同一条规矩走,两端必须一致。
      // 真要原样显示,markdown 里的写法本来就是加反引号(代理基本都会加)。
      expect(flat(find(parseMarkdown('重写 __init__ 方法'), 'strong')!.kids)).toBe('init')
      expect(flat(find(parseMarkdown('重写 `__init__` 方法'), 'code')!.kids)).toBe('__init__')
    })

    it('词**外面**的下划线仍然是强调 —— 这条规矩不许把功能一起关掉', () => {
      expect(flat(find(parseMarkdown('这是 _斜体_ 收尾'), 'em')!.kids)).toBe('斜体')
      expect(flat(find(parseMarkdown('这是 __粗体__ 收尾'), 'strong')!.kids)).toBe('粗体')
    })

    it('★左边界那个字符要原样留在正文里,不能被吃掉 —— 吃了就是两个词粘在一起', () => {
      // 变异测试抓到的:判边界要靠捕获组(Hermes 没有后行断言),而那个捕获组匹配到的字符
      // **不属于标记**。忘了把它吐回去,「这是 _斜体_」会变成「这是斜体」。
      expect(flat(parseMarkdown('这是 _斜体_ 收尾'))).toBe('这是 斜体 收尾')
      expect(flat(parseMarkdown('这是 __粗体__ 收尾'))).toBe('这是 粗体 收尾')
    })

    it('在行首/行尾也算词外面', () => {
      expect(find(parseMarkdown('_开头_'), 'em')).toBeTruthy()
    })

    it('★`*` 照旧做词内强调(GFM 只对 `_` 设这条限制)', () => {
      expect(find(parseMarkdown('a*b*c'), 'em')).toBeTruthy()
    })
  })
})

describe('标题 / 分隔线 / 引用', () => {
  it('# 到 ###### 落成 h1..h6', () => {
    expect(tags(parseMarkdown('# 一\n## 二\n###### 六'))).toEqual(['h1', 'h2', 'h6'])
  })

  it('★`#标题`(没空格)不是标题 —— 那是 markdown 的规矩,也挡住了「#1 号问题」这种写法', () => {
    expect(tags(parseMarkdown('#1 号问题'))).toEqual(['p'])
  })

  it('三条以上的 - * _ 是分隔线', () => {
    expect(tags(parseMarkdown('---\n\n***\n\n___'))).toEqual(['hr', 'hr', 'hr'])
  })

  it('> 引用,连续几行合成一段', () => {
    const ns = parseMarkdown('> 第一行\n> 第二行')
    expect(tags(ns)).toEqual(['blockquote'])
    expect(flat(ns)).toContain('第一行')
    expect(flat(ns)).toContain('第二行')
  })
})

describe('列表', () => {
  it('- * + 都算无序列表', () => {
    const ns = parseMarkdown('- 甲\n* 乙\n+ 丙')
    expect(tags(ns)).toEqual(['ul'])
    expect(all(ns, 'li')).toHaveLength(3)
  })

  it('有序列表', () => {
    const ns = parseMarkdown('1. 甲\n2. 乙')
    expect(tags(ns)).toEqual(['ol'])
    expect(find(ns, 'ol')!.start).toBe(1)
  })

  it('★★被段落打断的「懒编号」列表要接着数 —— 代理常把每一项都写成 `1.`', () => {
    // 源码就是 1、1。不接着数的话,用户看到的是一串「1.」。
    const ns = parseMarkdown('1. 甲\n\n中间插一段话\n\n1. 乙')
    const ols = all(ns, 'ol')
    expect(ols).toHaveLength(2)
    expect(ols[0].start).toBe(1)
    expect(ols[1].start).toBe(2)
  })

  it('★显式从 3 开始的列表尊重它自己的起始号', () => {
    expect(find(parseMarkdown('3. 丙\n4. 丁'), 'ol')!.start).toBe(3)
  })

  it('★新标题 = 新章节,有序编号从头开始', () => {
    const ns = parseMarkdown('1. 甲\n\n## 新一节\n\n1. 乙')
    const ols = all(ns, 'ol')
    expect(ols[1].start).toBe(1)
  })

  it('列表项里的行内标记照常生效', () => {
    expect(find(parseMarkdown('- 改 `a.ts`'), 'code')).toBeTruthy()
  })
})

describe('表格', () => {
  const T3 = '| 位置 | 行为 |\n|---|---|\n| `a.go:1` | 建单时快照 |\n| `b.go:2` | 收尾节点实时查 |'

  it('★★表头 + 分隔行 + 若干数据行 → 一张 table', () => {
    const ns = parseMarkdown(T3)
    expect(tags(ns)).toEqual(['table'])
    expect(all(ns, 'tr')).toHaveLength(3)
    expect(all(ns, 'th')).toHaveLength(2)
    expect(all(ns, 'td')).toHaveLength(4)
  })

  it('表头单元格是 th,数据是 td', () => {
    const rows = all(parseMarkdown(T3), 'tr')
    expect(rows[0].kids.every((k) => k.t === 'el' && k.tag === 'th')).toBe(true)
    expect(rows[1].kids.every((k) => k.t === 'el' && k.tag === 'td')).toBe(true)
  })

  it('单元格里的行内标记照常生效', () => {
    expect(flat(find(parseMarkdown(T3), 'code')!.kids)).toBe('a.go:1')
  })

  it('★首尾那对竖线不算出两个空列', () => {
    expect(all(parseMarkdown('| 甲 | 乙 |\n|---|---|\n| 1 | 2 |'), 'th')).toHaveLength(2)
  })

  it('不写首尾竖线也认', () => {
    expect(all(parseMarkdown('甲 | 乙\n---|---\n1 | 2'), 'th')).toHaveLength(2)
  })

  it('★行内代码里的竖线不是列边界 —— 不然 `a | b` 会把那一行多切出一列', () => {
    const rows = all(parseMarkdown('| 名 | 值 |\n|---|---|\n| x | `a | b` |'), 'tr')
    expect(rows[1].kids).toHaveLength(2)
  })

  it('★转义的 \\| 是一个竖线字符,不是列边界', () => {
    const rows = all(parseMarkdown('| 名 | 值 |\n|---|---|\n| x | a \\| b |'), 'tr')
    expect(rows[1].kids).toHaveLength(2)
    expect(flat([rows[1].kids[1]])).toContain('a | b')
  })

  it('★★软折行的续行折回上一格,不把整张表打散成竖线文本', () => {
    // 代理把一格写得很长时会自己折行,续行上没有竖线。
    const ns = parseMarkdown('| 名 | 说明 |\n|---|---|\n| x | 这句话很长\n所以折了行 |')
    expect(tags(ns)).toEqual(['table'])
    expect(flat(ns)).toContain('所以折了行')
  })

  it('表格遇空行结束', () => {
    expect(tags(parseMarkdown('| 甲 |\n|---|\n| 1 |\n\n后面一段话'))).toEqual(['table', 'p'])
  })

  it('★分隔行必须**紧跟**表头,否则那两行只是普通文字', () => {
    expect(tags(parseMarkdown('| 甲 | 乙 |\n还有一句\n|---|---|'))).toEqual(['p'])
  })

  it('★光秃秃一行 `---` 是分隔线,不是没有表头的表格', () => {
    expect(tags(parseMarkdown('一段话\n\n---\n\n又一段'))).toEqual(['p', 'hr', 'p'])
  })

  it('对齐冒号 `|:--|--:|` 照样认得出是分隔行', () => {
    expect(tags(parseMarkdown('| 甲 | 乙 |\n|:--|--:|\n| 1 | 2 |'))).toEqual(['table'])
  })
})

describe('混在一起(真实回答的样子)', () => {
  it('标题 + 段落 + 表格 + 列表,顺序不乱、一个字不丢', () => {
    const src = [
      '## 关键代码三处:',
      '',
      '| 位置 | 行为 |',
      '|---|---|',
      '| `a.go` | 建单时快照 |',
      '',
      '所以**口径不一致**:',
      '',
      '1. 建单按快照',
      '2. 校验按实时全量',
    ].join('\n')
    const ns = parseMarkdown(src)
    expect(tags(ns)).toEqual(['h2', 'table', 'p', 'ol'])
    expect(flat(ns)).toContain('口径不一致')
    expect(flat(ns)).toContain('校验按实时全量')
  })
})
