import type { HNode } from './htmlParse'

/**
 * Markdown 正文 → **`HtmlRender` 已经认识的那棵树**(`HNode`)。
 *
 * ★★为什么吐 `HNode` 而不是自己定义一套节点:手机端已经有一个用纯 RN 原语画
 *  标题/表格/列表/引用/粗斜体/行内代码/链接的渲染器(`HtmlRender.tsx`,给内嵌 HTML 用的)。
 *  markdown 需要的东西和它**完全重合**。共用同一个渲染器 ⇒ 同一段内容不管是模型吐的 HTML
 *  还是 markdown,长出来必然一模一样;各写一个的话,两套表格样式迟早会分叉,
 *  而分叉的那一天没有任何测试会红。
 *
 * ★★在这之前手机端**根本没有 markdown 渲染**:`MessageBody.tsx` 把每一段非代码、非 HTML 的
 *  正文原样当纯文本画。于是表格是原始竖线 `|---|---|`、`**` 和反引号原样露出、标题和列表全是平的
 *  —— 2026-09-01 用户发截图报的就是这个。
 *
 * ★规则**照抄电脑端** `src/renderer/views/chat/markdown.tsx`。抄的是规矩不是代码(那边直接吐 DOM,
 *  这里没有 DOM):那个文件里每一条注释都对应一个真栽过的坑,重新发明一遍等于重新踩一遍。
 *  两端支持的语法必须一致 —— 同一条回答在电脑上和手机上长得不一样,是最难解释的一种 bug。
 *
 * ★**围栏代码块不归这里管**:`MessageBody` 先用 `splitCodeChunks` 把 ``` 切走(那样每段代码
 *  才有自己的复制按钮),再用 `splitHtmlChunks` 切走内嵌 HTML。到这里的文本里没有围栏。
 *
 * ★这个文件**只有一个 type import**(编译后不产生任何 import),同 `codeChunks.ts` / `htmlParse.ts`:
 *  它决定「一段文字被画成什么」,必须有测试钉着,而仓库根那个 `mobile` vitest project 是 node 环境、
 *  加载不了 react-native。
 */

type El = Extract<HNode, { t: 'el' }>

const el = (tag: El['tag'], kids: HNode[], extra?: Partial<El>): El => ({ t: 'el', tag, kids, ...extra })
const txt = (text: string): HNode => ({ t: 'text', text })

// ── 行内 ────────────────────────────────────────────────────────────────────

/**
 * 裸 URL 自动链接化。
 *
 * ★地址正文里排除空白、尖括号引号、中文标点和**汉字** —— 代理写「打开https://x/然后」时
 *  中文紧贴着地址,不排除就会把后半句话吞进链接。
 * ★最后一个字符另外再排除收尾标点:「见 https://x/a。」的句号属于句子。代价是真以 `)` 结尾的
 *  地址(维基百科那种)会掉一个右括号,换来的是 `(见 https://x/a)` 这种常见写法不吃括号。
 */
const URL_BODY = '\\s<>"\'`（）【】「」，。、；：！？\\u4e00-\\u9fff'
const BARE_URL = new RegExp(`https?://[^${URL_BODY}]*[^${URL_BODY}.,;:!?)\\]}]`)

/**
 * 一段文字 → 行内节点。
 *
 * ★★**优先级由「谁的 `m.index` 最小」决定,不由下面这张表的顺序决定。**
 *  `` `curl https://x` `` 里 code 从反引号处命中(下标更小)所以赢;`[文字](https://x)` 里
 *  链接从 `[` 处命中所以赢。两条各有一条测试钉着 —— 别指望靠调这张表的顺序来改优先级。
 */
function inline(src: string): HNode[] {
  const out: HNode[] = []
  let rest = src
  /**
   * `lead: true` = 这条规则的 `m[1]` 是**左边界那个字符**,不属于标记本身,要原样留在正文里。
   *
   * ★★为什么不用后行断言 `(?<=…)`:**Hermes(RN 的引擎)不支持**,写了会在真机上抛 SyntaxError,
   *  而 node 那套测试全绿 —— 正是「测试骗过了自己」最典型的一种。前瞻 `(?!…)` 是 ES3 就有的,可以用。
   */
  const RULES: { re: RegExp; make: (m: RegExpExecArray) => HNode; lead?: boolean }[] = [
    { re: /`([^`]+)`/, make: (m) => el('code', [txt(m[1])]) },
    // ★图片**降级成链接**:手机端一个远程请求都不许发(同 `htmlParse.ts` 把 `<img>` 挡在白名单外 ——
    //  远程 src 是追踪信标 + 出口 IP 泄露)。但地址不能丢:做成一条要人主动点、由系统浏览器打开的链接,
    //  文字用 alt。图标是给人一眼看出「这原本是张图」用的。
    // ★`![alt](src)` 比 `[…](…)` **早一个字符**命中,所以「最小下标」那条规矩自然会选中它,
    //  不会渲染成一个孤零零的 `!` 加一条链接。★它排在链接前面只是读起来顺,**不是**靠顺序生效的
    //  —— 把这两条对调,测试仍然全绿(变异验证过)。
    {
      re: /!\[([^\]]*)\]\(([^)\s]+)\)/,
      make: (m) => el('a', [txt(`🖼 ${m[1] || '图片'}`)], { href: m[2] }),
    },
    { re: /\[([^\]]+)\]\(([^)\s]+)\)/, make: (m) => el('a', inline(m[1]), { href: m[2] }) },
    { re: BARE_URL, make: (m) => el('a', [txt(m[0])], { href: m[0] }) },
    { re: /\*\*([^*]+)\*\*/, make: (m) => el('strong', inline(m[1])) },
    // ★★下划线**不做词内强调**(GFM 的规矩,`*` 做、`_` 不做)。
    //  代理的回答里全是 `apply_status` / `ACTIVITY_END_STATUS` 这种蛇形命名 —— 不设这条限制的话,
    //  「apply_status 仍 EFFECTIVE + 无 ACTIVITY_END」会被配成一对,变成
    //  `apply` + 斜体`status 仍 EFFECTIVE + 无 ACTIVITY` + `END`:**下划线整个消失,还多出一片斜体**。
    //  2026-09-01 第一版截图上一眼就看出来了。
    //  左边界靠捕获组 + `lead`(见上面为什么不能用后行断言),右边界靠前瞻。
    { re: /(^|[^A-Za-z0-9_])__([^_]+)__(?![A-Za-z0-9_])/, make: (m) => el('strong', inline(m[2])), lead: true },
    { re: /\*([^*]+)\*/, make: (m) => el('em', inline(m[1])) },
    { re: /(^|[^A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/, make: (m) => el('em', inline(m[2])), lead: true },
    { re: /~~([^~]+)~~/, make: (m) => el('del', inline(m[1])) },
  ]
  while (rest) {
    let best: { idx: number; len: number; node: HNode } | null = null
    for (const { re, make, lead } of RULES) {
      const m = re.exec(rest)
      if (!m) continue
      // `lead` 规则里 m[1] 是左边界那个字符(可能是空串),它不属于标记 —— 起点往后挪、长度相应减。
      const skip = lead ? m[1].length : 0
      const idx = m.index + skip
      if (best === null || idx < best.idx) best = { idx, len: m[0].length - skip, node: make(m) }
    }
    if (!best) {
      out.push(txt(rest))
      break
    }
    if (best.idx > 0) out.push(txt(rest.slice(0, best.idx)))
    out.push(best.node)
    rest = rest.slice(best.idx + best.len)
  }
  return out
}

/** 一段(可能有软换行)→ 行内节点,换行落成 `<br>`。 */
function inlineLines(lines: string[]): HNode[] {
  const out: HNode[] = []
  lines.forEach((ln, i) => {
    if (i > 0) out.push(el('br', []))
    out.push(...inline(ln))
  })
  return out
}

// ── 表格 ────────────────────────────────────────────────────────────────────

/** GFM 的分隔行:`|---|---:|`、`:--|--:`、光秃秃的 `---` 都算。 */
const SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/**
 * 一行拆成单元格 —— 只在**真正是列边界**的竖线上切。
 *
 * ★行内代码里的竖线不算:`` `a | b` `` 被朴素的 `split('|')` 一切就多出一列,整行错位。
 * ★`\|` 是 GFM 里的字面竖线,要还原成一个 `|` 字符。
 * ★首尾那对空单元格丢掉(`| 甲 | 乙 |` 切出来头尾各有一个空串),否则每张表都多两个空列。
 */
function splitRow(raw: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inCode = false
  for (let p = 0; p < raw.length; p++) {
    const ch = raw[p]
    if (!inCode && ch === '\\' && raw[p + 1] === '|') {
      cur += '|'
      p++
      continue
    }
    if (ch === '`') {
      inCode = !inCode
      cur += ch
      continue
    }
    if (ch === '|' && !inCode) {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur)
  const trimmed = cells.map((c) => c.trim())
  if (trimmed.length && trimmed[0] === '') trimmed.shift()
  if (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed
}

// ── 块级 ────────────────────────────────────────────────────────────────────

export function parseMarkdown(src: string): HNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: HNode[] = []
  const para: string[] = []
  let i = 0

  const flushPara = (): void => {
    if (!para.length) return
    const lns = para.slice()
    para.length = 0
    if (!lns.join('').trim()) return
    out.push(el('p', inlineLines(lns)))
  }

  /**
   * 有序列表的连续编号。
   * ★★代理很爱把每一项都写成 `1.`(源码就是 1、1、1)。中间只要插一段话,这个按行扫的解析器
   *  就会把列表截断成好几个单项 `<ol>`,各自从 1 开始 ⇒ 用户看到一串「1.」。用一个跨块的计数器
   *  接着数;遇到标题(=新章节)清零;显式从 >1 开始的列表尊重它自己的起始号。
   */
  let olSeq = 0

  while (i < lines.length) {
    const line = lines[i]

    // 表格:带竖线的表头行 + **紧跟**的分隔行。放在最前面,因为它要看下一行。
    if (line.includes('|') && i + 1 < lines.length && SEP.test(lines[i + 1])) {
      flushPara()
      const header = splitRow(line)
      i += 2 // 跳过表头 + 分隔行
      const body: string[][] = []
      // 表格到空行为止(GFM 就是这么定的)。
      // ★没有竖线、或者列数比表头少的物理行,是上一行**软折行**的续行(代理把一格写长了会自己折),
      //  折回上一格 —— 不折的话整张表会碎成一堆竖线文本。
      while (i < lines.length && lines[i].trim() !== '') {
        const cells = lines[i].includes('|') ? splitRow(lines[i]) : null
        if (cells && cells.length >= header.length) {
          body.push(cells)
          i++
        } else if (body.length) {
          const last = body[body.length - 1]
          last[last.length - 1] += ' ' + (cells ? cells.join(' ') : lines[i].trim())
          i++
        } else break
      }
      out.push(
        el('table', [
          el('tr', header.map((h) => el('th', inline(h)))),
          ...body.map((row) => el('tr', row.map((cell) => el('td', inline(cell))))),
        ]),
      )
      continue
    }

    // 标题。★`#` 后面必须有空格(markdown 的规矩),这也顺带挡住了「#1 号问题」这种写法。
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      olSeq = 0
      out.push(el(`h${h[1].length}` as El['tag'], inline(h[2])))
      i++
      continue
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara()
      out.push(el('hr', []))
      i++
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      out.push(el('ul', items.map((it) => el('li', inline(it)))))
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara()
      const srcNum = parseInt(/^\s*(\d+)\./.exec(line)?.[1] ?? '1', 10)
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      const start = srcNum === 1 ? olSeq + 1 : srcNum
      olSeq = start + items.length - 1
      out.push(el('ol', items.map((it) => el('li', inline(it))), { start }))
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(el('blockquote', [el('p', inlineLines(quote))]))
      continue
    }

    // 空行 = 分段
    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }

    para.push(line)
    i++
  }
  flushPara()
  return out
}
