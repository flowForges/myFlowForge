/**
 * 内嵌 HTML 片段 → 一棵**能用 React Native 原语画出来**的小树。
 *
 * 背景:电脑端有「对话区内嵌 HTML 可视化」,模型会在正文里穿插一小段自包含 HTML(对比矩阵、
 * 信息卡片、结构清单)。手机端一直是**折起来 + 标「手机端不渲染」** —— 诚实,但用户原话是
 * 「html不渲染」,他要的是看见。用户同时明确否掉了 WebView(不想再多一个原生依赖),
 * 所以这里只用 RN 原语画一个**受限子集**。
 *
 * ★三条硬规矩,抄自电脑端 `src/renderer/views/chat/htmlFragment.tsx`(拿的是规矩,不是 DOM 代码 ——
 *  这里没有 DOM):
 *  ① **构造性白名单**,不是黑名单过滤。不在名单上的标签/属性不是「被洗掉」,而是压根没有代码路径
 *     能把它构造出来。`<script>` / `onclick=` 走不到输出树里,不是因为我记得去删它们。
 *  ② **绝不执行、绝不联网**。没有等价于 innerHTML 的东西,没有远程图片,没有 iframe。
 *     `<img>` 根本不在名单上 —— 远程 src 是追踪信标 + 出口 IP 泄露。
 *  ③ 颜色一律走令牌 —— 那部分在渲染层(`HtmlRender.tsx`),这个文件只出数据。
 *
 * ★**画不忠实就整段不画**(`ok: false`),交回给原来那个折叠占位。这条比什么都重要:
 *  画出半个表格、丢掉一半单元格,而人以为自己看到的就是全部 —— 那比不画危险得多。
 *  所以任意 CSS(`style=`)、未知标签、太深的嵌套、没闭合的标签,一律整段退回,不做局部丢弃。
 *
 * ★这个文件**零 import**(同 `codeChunks.ts` / `htmlChunks.ts`):它决定「哪一段内容被当成可渲染的」,
 *  判错就是把内容画错或藏起来,必须有测试钉着 —— 而仓库根那个 `mobile` vitest project 是 node 环境,
 *  加载不了 react-native。
 */

/** 能画的标签。名单之外的一律整段退回。 */
export type HTag =
  | 'p' | 'div' | 'br' | 'hr' | 'blockquote'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'ul' | 'ol' | 'li'
  | 'strong' | 'b' | 'em' | 'i' | 'code' | 'pre' | 'span' | 'small' | 'del'
  | 'a'
  | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td'

export type HNode =
  | { t: 'text'; text: string }
  | { t: 'el'; tag: HTag; kids: HNode[]; href?: string; colSpan?: number; rowSpan?: number }

/** 解析结果。`ok: false` 时**没有树**可用 —— 调用方必须退回折叠占位,不能画一半。 */
export type HtmlParse =
  | { ok: true; nodes: HNode[] }
  | { ok: false; reason: string }

const TAGS: ReadonlySet<string> = new Set<HTag>([
  'p', 'div', 'br', 'hr', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'strong', 'b', 'em', 'i', 'code', 'pre', 'span', 'small', 'del',
  'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
])

/** 自闭合:不入栈,也不能有子节点。 */
const VOID: ReadonlySet<string> = new Set(['br', 'hr'])

/**
 * 每个标签**唯一**放行的属性。空 = 一个属性都不许带。
 *
 * ★`style` / `class` / `id` 一概不在名单上,于是带它们的片段整段退回折叠占位 —— 这是故意的:
 *  内联 CSS 携带的往往正是这段片段的**全部意思**(两栏、配色、卡片边框)。忽略掉照画不误,
 *  等于把一张卡片画成一堆没头没尾的句子,而人以为自己看到的就是模型想表达的。
 */
const ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
}
const NO_ATTRS: ReadonlySet<string> = new Set()

/** 链接只放行这三种 scheme。`javascript:` / `data:` / 站内锚点全部退回 —— 我们点不开,也不该假装能点。 */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i

/**
 * 嵌套上限。正常片段(表格、列表、卡片)三五层就到头了;再深多半是电脑端那种多层布局 div,
 * 画出来在 390pt 宽上必然挤成一坨 —— 那种整段退回比硬画忠实。
 */
export const HTML_MAX_DEPTH = 8

/** 整段长度上限。几十 KB 的表格在手机上画出来就是几秒白屏,折起来反而是对的。 */
export const HTML_MAX_LEN = 20_000

/** 里面的空白必须原样保留的标签。 */
const PRE: ReadonlySet<string> = new Set(['pre'])

/** 纯空白的文本子节点要丢掉的容器 —— 不丢的话表格行之间会多出一串空文本,画成一条条空行。 */
const STRIP_WS: ReadonlySet<string> = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'div', 'blockquote'])

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×',
}

/**
 * 实体解码。★必须做:不解码的话 `&amp;&amp;` 会**原样**显示成 `&amp;&amp;`,
 * 而它在正文里代表的是 `&&` —— 一段 shell 条件会被显示成一串乱码。
 * ★而且必须**最后一步**做:先解码再解析,`&lt;script&gt;` 就会变成一个真的 `<script>` 标签。
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // 码位不合法 / 控制字符 → 原样留着。造一个 U+0000 出来只会让 RN 画出一个豆腐块。
      if (!Number.isFinite(n) || n < 32 || n > 0x10ffff) return all
      try { return String.fromCodePoint(n) } catch { return all }
    }
    return NAMED[body.toLowerCase()] ?? all
  })
}

type Frame = { tag: HTag; kids: HNode[]; href?: string; colSpan?: number; rowSpan?: number }

const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/
const ATTR_RE = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function bad(reason: string): HtmlParse { return { ok: false, reason } }

/**
 * 解析一段片段。**任何一处不确定都整段退回** —— 返回 `{ ok:false }`,调用方去画折叠占位。
 */
export function parseHtmlSubset(src: string): HtmlParse {
  if (src.length > HTML_MAX_LEN) return bad('too-long')
  const root: HNode[] = []
  const stack: Frame[] = []
  const top = (): HNode[] => (stack.length ? stack[stack.length - 1].kids : root)
  const inPre = (): boolean => stack.some((f) => PRE.has(f.tag))

  let buf = ''
  const flushText = (): void => {
    if (!buf) return
    const raw = decodeEntities(buf)
    buf = ''
    if (inPre()) { top().push({ t: 'text', text: raw }); return }
    // HTML 的空白折叠。不折的话源码里的换行和缩进会原样变成句子中间的一大串空格。
    const text = raw.replace(/\s+/g, ' ')
    const parentTag = stack.length ? stack[stack.length - 1].tag : 'div'
    if (!text.trim() && STRIP_WS.has(parentTag)) return
    if (!text) return
    top().push({ t: 'text', text })
  }

  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch !== '<') { buf += ch; i++; continue }

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      // 没闭合的注释:后面全是注释内容还是正文?说不准 —— 说不准就整段退回。
      if (end < 0) return bad('unclosed-comment')
      flushText()
      i = end + 3
      continue
    }
    // `<!DOCTYPE`、CDATA、处理指令:片段里不该有,出现了说明这不是「一小段片段」。
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) return bad('unsupported-directive')

    const m = TAG_RE.exec(src.slice(i))
    // `<` 后面不是标签(`a < b`),当普通字符。
    if (!m) { buf += ch; i++; continue }

    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    // ★贪婪的属性组会把 `<br/>` 结尾那个 `/` 一起吃进去(`m[4]` 于是永远是空的),所以自闭合
    //  要在属性串尾巴上认。★但必须要求它**前面是空白或整串就是它** —— 否则
    //  `<a href=https://x/>` 这种不带引号的写法会被砍掉 URL 末尾那个斜杠。
    let attrs = m[3]
    let selfClose = m[4] === '/'
    if (!selfClose && /(^|\s)\/\s*$/.test(attrs)) { selfClose = true; attrs = attrs.replace(/\/\s*$/, '') }
    i += m[0].length

    if (!TAGS.has(tag)) return bad(`unknown-tag:${tag}`)
    const t = tag as HTag

    if (closing) {
      if (attrs.trim()) return bad('close-tag-with-attrs')
      if (VOID.has(t)) continue                       // `</br>` 这种手滑,忽略即可
      // ★先 flush 再 pop:此刻 `top()` 正是要闭合的那个 frame 的 kids,攒着的文本属于**它**,
      //  pop 完再 flush 就落到它父亲身上去了(`<li>a</li>` 的 a 会跑到 `<ul>` 底下)。
      flushText()
      const f = stack.pop()
      // 闭标签对不上开标签 = 结构是坏的。HTML 的宽松语义会「猜」,猜错就是把后面半段吞掉。
      if (!f || f.tag !== t) return bad('mismatched-close')
      top().push({
        t: 'el', tag: f.tag, kids: f.kids,
        ...(f.href ? { href: f.href } : null),
        ...(f.colSpan ? { colSpan: f.colSpan } : null),
        ...(f.rowSpan ? { rowSpan: f.rowSpan } : null),
      })
      continue
    }

    flushText()

    // ---- 属性:名单之外一个都不许 ----
    const allow = ATTRS[t] ?? NO_ATTRS
    let href: string | undefined
    let colSpan: number | undefined
    let rowSpan: number | undefined
    ATTR_RE.lastIndex = 0
    let a: RegExpExecArray | null
    while ((a = ATTR_RE.exec(attrs)) !== null) {
      const name = a[1].toLowerCase()
      const value = a[2] ?? a[3] ?? a[4] ?? ''
      // ★`on*` 单列一句不是因为白名单不够 —— 名单已经拦住它了。这里只是让退回原因说人话,
      //  真机上看日志时一眼知道是「模型吐了个带事件处理器的片段」。
      if (name.startsWith('on')) return bad(`event-attr:${name}`)
      if (!allow.has(name)) return bad(`attr:${t}.${name}`)
      if (name === 'href') {
        const h = decodeEntities(value).trim()
        if (!SAFE_HREF.test(h)) return bad('unsafe-href')
        href = h
      } else {
        const v = parseInt(value, 10)
        if (!Number.isFinite(v) || v < 1 || v > 64) return bad(`span:${name}`)
        if (name === 'colspan') colSpan = v
        else rowSpan = v
      }
    }
    if (t === 'a' && !href) return bad('a-without-href')

    if (VOID.has(t) || selfClose) {
      // 自闭合写法用在非空标签上(`<td/>`)也认:空元素,不入栈。
      top().push({ t: 'el', tag: t, kids: [], ...(href ? { href } : null), ...(colSpan ? { colSpan } : null), ...(rowSpan ? { rowSpan } : null) })
      continue
    }
    if (stack.length + 1 > HTML_MAX_DEPTH) return bad('too-deep')
    stack.push({ tag: t, kids: [], href, colSpan, rowSpan })
  }
  flushText()
  // 还有没闭合的标签:模型正在流式吐字,或者片段本来就是坏的。两种都不画 —— 画一半的表格
  // 比不画更容易骗人。
  if (stack.length) return bad('unclosed-tag')
  if (!root.length) return bad('empty')
  return { ok: true, nodes: root }

}
