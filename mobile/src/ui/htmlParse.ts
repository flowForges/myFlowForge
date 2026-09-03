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
 *
 * ★★但「不忠实」的**判据 2026-09-03 收窄过一次**,起因是用户原话「很多内容看不到」。
 *  原来**未知标签一律整段退回**,而代理写的 HTML 里 `<section>` `<figure>` `<summary>`
 *  `<h1>` 这类容器随处可见 —— 一个没见过的外壳,整段内容就没了。电脑端那份
 *  (`src/renderer/views/chat/htmlFragment.tsx:120`)从一开始就不是这么干的,它写着
 *  「未知标签:拆掉标签本身,保留子节点 —— 内容不该因为一个没见过的容器就整段消失」。
 *  两边现在对齐成**同一套三分法**:
 *    ① 白名单里的 → 照画;
 *    ② `DROP_SUBTREE`(script/style/svg/iframe…)→ **整棵子树丢掉**。它们的文本是代码或
 *       元数据,不是给人读的正文,留下来只会漏出一堆 JS 源码;
 *    ③ 其余未知标签 → **拆掉标签、子节点提升到父级**。结构降一级,但一个字都不丢。
 *  真正的「不忠实」只剩下面那两条:纯 CSS 画出来的东西、以及整段一个字都渲染不出来。
 * ★但**装饰不算「不忠实」**:`style` / `class` / `on*` 这些丢掉照画(见 `decorative` 那段注释)。
 *  标签全在白名单里,结构和每一个字都在,丢的只有配色间距 —— 而整段退回是**一个字都不给**。
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
  | {
      t: 'el'
      tag: HTag
      kids: HNode[]
      href?: string
      colSpan?: number
      rowSpan?: number
      /**
       * `<ol>` 从几开始数。★这个文件**不产出**它(HTML 那边 `start` 不在白名单属性里),
       * 它是给 `mdParse.ts` 用的:markdown 里代理常把每一项都写成 `1.`,被段落打断之后
       * 每个 `<ol>` 都从 1 开始 ⇒ 用户看到一串「1.」。两边共用同一个渲染器,
       * 所以这个字段挂在共用的树上。
       */
      start?: number
    }

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

/**
 * 连**整棵子树**一起丢掉的标签。★抄自电脑端的 `DROP_SUBTREE`,一个不多一个不少。
 *
 * 它们和「未知标签」的区别在于:未知标签的**文字是正文**(所以拆掉外壳留下内容),
 * 而这些标签的文字是**代码或元数据** —— 把 `<script>` 的内容当正文留下来,
 * 屏幕上就是一大段 JS 源码。`<svg>` 同理:一堆 `d="M12 0L…"` 的路径数据,不是给人读的。
 *
 * ★`img` / `picture` 在这儿而不在白名单里:远程 `src` 是追踪信标 + 出口 IP 泄露,
 *  而这个渲染器**一个网络请求都不发**。
 */
const DROP_SUBTREE: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'option',
  'textarea', 'link', 'meta', 'base', 'title', 'noscript', 'template', 'svg', 'math', 'canvas',
  'audio', 'video', 'source', 'track', 'img', 'picture', 'head', 'applet', 'frame', 'frameset',
])

/**
 * 几个**语义清楚**的标签,直接映射到白名单里已有的那一个,而不是走「拆掉外壳」。
 *
 * ★为什么不能一律拆:拆掉的标签**不占一行**了 —— 子节点被提升到父级,和前后的文字连成一片。
 *  对 `<section>` 这种纯容器没关系(它的孩子本来就是块级),但 `<dt>` / `<dd>` / `<summary>`
 *  **自己就是那个块边界** —— 拆掉之后「术语」和「解释」会挤成一行,看起来就是画错了。
 * ★映射不是「猜」:每一条都是把一个块级映到块级、行内映到行内,降的只有样式。
 */
const ALIAS: Record<string, HTag> = {
  // 纯容器 —— 电脑端那边它们本来也就是个 div
  section: 'div', article: 'div', figure: 'div', header: 'div', footer: 'div',
  main: 'div', nav: 'div', aside: 'div', details: 'div', html: 'div', body: 'div',
  figcaption: 'p', caption: 'p',
  // 块边界(拆掉就会和邻居挤成一行)
  summary: 'h4', dl: 'div', dt: 'h5', dd: 'p',
  // 行内
  sup: 'small', sub: 'small', mark: 'strong', u: 'span', ins: 'span',
  abbr: 'span', cite: 'span', q: 'span', s: 'del', strike: 'del',
  kbd: 'code', samp: 'code', var: 'code', tfoot: 'tbody',
}


/**
 * 每个标签**唯一**放行的属性 —— 只有这些会被读出来带进树里。
 */
const ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
}
const NO_ATTRS: ReadonlySet<string> = new Set()

/**
 * **纯装饰**属性:一律丢掉,继续画。
 *
 * ★这条policy改过一次,原因值得记下来。第一版是「不认识的属性 ⇒ 整段退回折叠占位」,
 *  理由是「内联 CSS 往往就是这段片段的全部意思」。拿真实片段一跑就知道那是纸上谈兵:
 *  代理写的 HTML **几乎每一段都带 `style=` 或 `class=`**,于是用户看到的还是那个
 *  「手机端不渲染」—— 而他的原话就是「html不渲染」。等于什么都没改。
 * ★**丢装饰 ≠ 画一半**,这是两种完全不同的失败:标签全在白名单里,结构和每一个字都照画不误,
 *  丢的只有配色和间距。一张没有 CSS 的表格仍然是一张正确的表格;一张被换成
 *  「手机端不渲染」的表格什么都不是。
 * ★`on*` 也在这里丢而不是退回:RN 的树里没有任何东西会被执行,`onclick` 的值就是一串字符,
 *  而它周围那段正文人是要读的。白名单仍然是**构造性**的 —— 输出树里没有承载事件处理器的字段,
 *  所以「不会执行」不是因为我信任下游,而是因为**解析器根本产不出来**(有测试钉着)。
 */
function decorative(name: string): boolean {
  return (
    name === 'style' || name === 'class' || name === 'id' || name === 'title' || name === 'role' ||
    name.startsWith('data-') || name.startsWith('aria-') || name.startsWith('on')
  )
}

/** 链接只放行这三种 scheme。`javascript:` / `data:` / 站内锚点全部退回 —— 我们点不开,也不该假装能点。 */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i

/**
 * 嵌套上限。★**和电脑端同一个数(24)**,那边写着「病态嵌套的兜底,正常片段远达不到」。
 *
 * ★原来是 8,理由是「再深多半是布局 div,画出来会挤成一坨」。那个理由站不住:
 *  布局 div 现在会被拆掉(见文件头三分法第 ③ 条),深度自然就降下来了;而 8 这个数
 *  拦掉的其实是**正常的表格**(table→tbody→tr→td→p→strong 就已经 6 层),
 *  再套一层卡片就整段退回 —— 那正是用户看到的「很多内容看不到」。
 */
export const HTML_MAX_DEPTH = 24

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

/**
 * 栈上的一层。`kind` 决定它闭合时怎么落地(文件头那套三分法):
 *  · `el`   白名单标签、或经 `ALIAS` 映射过来的 —— 落成一个节点
 *  · `skip` 未知标签 —— **拆掉外壳,子节点提升到父级**
 *  · `drop` `DROP_SUBTREE` —— 整棵丢掉
 *
 * ★`name` 是**原始标签名**,闭标签只跟它比。拿映射后的名字比的话,`</section>` 会被判成
 *  「和 `<div>` 对不上」,整段退回 —— 而那正是这次要修的毛病。
 * ★`tag` 只在 `kind==='el'` 时有意义;另外两种给 `'div'` 占位,而所有会读它的地方
 *  (`inPre` / 空白折叠)都改成**只看最近的那个 `el` 层** —— 因为 skip 层的孩子最终
 *  就是落在那一层里。
 */
type Frame = {
  name: string
  kind: 'el' | 'skip' | 'drop'
  tag: HTag
  kids: HNode[]
  href?: string
  colSpan?: number
  rowSpan?: number
}

/** 真正的 HTML 空元素:永远没有闭标签,所以开标签处理完就走,不入栈。 */
const HTML_VOID: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr',
])

/**
 * **原文本元素**:里面的内容不是 HTML,是脚本 / 样式 / 纯文字。
 *
 * ★★必须按字面跳到闭标签,不能交给解析器 —— 一段 JS 里的 `if (a < b)` 无所谓(匹配不上标签),
 *  但 `const s = "&lt;div&gt;"` 里那个 `<div>` 会被当成**真标签**入栈,而它永远不会闭合
 *  ⇒ 整段 `unclosed-tag` 退回。它们本来就要被整棵丢掉,连解析都不该解析。
 */
const RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title'])

/** 一个标签归三分法里的哪一类。 */
function classify(raw: string): { kind: Frame['kind']; tag: HTag } {
  if (TAGS.has(raw)) return { kind: 'el', tag: raw as HTag }
  const a = ALIAS[raw]
  if (a) return { kind: 'el', tag: a }
  if (DROP_SUBTREE.has(raw)) return { kind: 'drop', tag: 'div' }
  return { kind: 'skip', tag: 'div' }
}

// ★标签名里放行 `-`:自定义元素(`<my-card>`)是「未知容器」里最常见的一种,而它正是
//  这次改动要救的东西。不放行的话 `</my-card>` 会被切成「标签 my + 属性 -card」,
//  当场撞上 `close-tag-with-attrs` —— 报的错和真实原因完全对不上。
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/
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
  /** 这些文字最终会落进哪个**真节点**里 —— skip 层是透明的,不算。 */
  const nearestEl = (): HTag => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind === 'el') return stack[k].tag
    return 'div'
  }
  const inPre = (): boolean => stack.some((f) => f.kind === 'el' && PRE.has(f.tag))

  let buf = ''
  const flushText = (): void => {
    if (!buf) return
    const raw = decodeEntities(buf)
    buf = ''
    if (inPre()) { top().push({ t: 'text', text: raw }); return }
    // HTML 的空白折叠。不折的话源码里的换行和缩进会原样变成句子中间的一大串空格。
    const text = raw.replace(/\s+/g, ' ')
    const parentTag = nearestEl()
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
    // `<!DOCTYPE`、CDATA、处理指令:**跳过就行,不再整段退回**。
    // ★代理经常吐一整份 `<!DOCTYPE html><html>…</html>`,而那份文档的 body 里全是正文。
    //  为了开头那一行指令把整段折起来,是这次要修的毛病里最容易发生的一种。
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9)
      if (end < 0) return bad('unclosed-cdata')
      flushText()
      i = end + 3
      continue
    }
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
      const end = src.indexOf('>', i)
      if (end < 0) return bad('unclosed-directive')
      flushText()
      i = end + 1
      continue
    }

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

    let { kind, tag: t } = classify(tag)

    if (closing) {
      if (attrs.trim()) return bad('close-tag-with-attrs')
      // 空元素永远没有闭标签。`</br>` `</img>` 这种手滑忽略即可 —— 它们开标签时就没入栈,
      // 去 pop 只会把**外面那一层**弹掉,后面全乱。
      if (HTML_VOID.has(tag)) continue
      // ★先 flush 再 pop:此刻 `top()` 正是要闭合的那个 frame 的 kids,攒着的文本属于**它**,
      //  pop 完再 flush 就落到它父亲身上去了(`<li>a</li>` 的 a 会跑到 `<ul>` 底下)。
      flushText()
      const f = stack.pop()
      // 闭标签对不上开标签 = 结构是坏的。HTML 的宽松语义会「猜」,猜错就是把后面半段吞掉。
      // ★比的是**原始名**,不是映射后的:`<section>…</section>` 两边都是 section。
      if (!f || f.name !== tag) return bad('mismatched-close')
      if (f.kind === 'el') {
        top().push({
          t: 'el', tag: f.tag, kids: f.kids,
          ...(f.href ? { href: f.href } : null),
          ...(f.colSpan ? { colSpan: f.colSpan } : null),
          ...(f.rowSpan ? { rowSpan: f.rowSpan } : null),
        })
      } else if (f.kind === 'skip') {
        // 拆掉外壳:孩子提升到父级。★一个字都不丢,丢的只有那层容器。
        for (const k of f.kids) top().push(k)
      }
      // 'drop' → 什么都不推,整棵子树到此为止
      continue
    }

    flushText()

    // ---- 属性 ----
    // ★只有 `el` 才校验:`skip` / `drop` 那两类标签我们压根不画,它们身上有什么属性
    //  与画出来的东西无关。原来对所有标签一视同仁地校验,于是 `<section data-x>` 这种
    //  也能把整段拖下水。
    let href: string | undefined
    let colSpan: number | undefined
    let rowSpan: number | undefined
    if (kind === 'el') {
      const allow = ATTRS[t] ?? NO_ATTRS
      ATTR_RE.lastIndex = 0
      let a: RegExpExecArray | null
      while ((a = ATTR_RE.exec(attrs)) !== null) {
        const name = a[1].toLowerCase()
        const value = a[2] ?? a[3] ?? a[4] ?? ''
        // 装饰(style / class / id / data-* / aria-* / title / role / on*):丢掉,接着画。见 `decorative`。
        if (decorative(name)) continue
        // 剩下的仍然是**构造性白名单**:名单外的属性说明这个标签在这段片段里承担的作用我们读不懂
        //  (`<div href=…>`、`<p colspan=…>`),那种退回折叠占位。
        if (!allow.has(name)) return bad(`attr:${t}.${name}`)
        if (name === 'href') {
          const h = decodeEntities(value).trim()
          // ★`javascript:` / `data:` / 站内锚点:**降级成普通文字**,不再整段退回。
          //  链接点不开是装饰层面的损失,而整段退回是一个字都不给 —— 后者严重得多。
          //  安全性不受影响:href 没被写进树,输出里就没有可点的东西。
          if (SAFE_HREF.test(h)) href = h
          else kind = 'skip'
        } else {
          const v = parseInt(value, 10)
          if (!Number.isFinite(v) || v < 1 || v > 64) return bad(`span:${name}`)
          if (name === 'colspan') colSpan = v
          else rowSpan = v
        }
      }
      // `<a>` 没有 href:同样降级成普通文字,把字留下。
      if (t === 'a' && !href) kind = 'skip'
    }

    // 原文本元素:内容按字面跳到闭标签,整段丢掉(理由见 RAW_TEXT 上面那段)。
    if (RAW_TEXT.has(tag) && !selfClose) {
      const close = new RegExp(`</${tag}\\s*>`, 'i')
      const rest = src.slice(i)
      const m2 = close.exec(rest)
      // 没闭合:这段后面全是脚本内容,当作到结尾。★不退回整段 —— 前面已经画好的正文还在。
      i = m2 ? i + m2.index + m2[0].length : n
      continue
    }

    // 空元素:开标签处理完就走,不入栈(它们没有闭标签)。
    if (HTML_VOID.has(tag)) {
      if (kind === 'el') top().push({ t: 'el', tag: t, kids: [] })
      continue
    }
    if (selfClose) {
      // 自闭合写法用在非空标签上(`<td/>`)也认:空元素,不入栈。
      if (kind === 'el') {
        top().push({ t: 'el', tag: t, kids: [], ...(href ? { href } : null), ...(colSpan ? { colSpan } : null), ...(rowSpan ? { rowSpan } : null) })
      }
      continue
    }
    if (stack.length + 1 > HTML_MAX_DEPTH) return bad('too-deep')
    stack.push({ name: tag, kind, tag: t, kids: [], href, colSpan, rowSpan })
  }
  flushText()
  // 还有没闭合的标签:模型正在流式吐字,或者片段本来就是坏的。两种都不画 —— 画一半的表格
  // 比不画更容易骗人。
  if (stack.length) return bad('unclosed-tag')
  if (!root.length) return bad('empty')
  // ★丢掉 `style=` 之后多出来的一个新失败面:**纯 CSS 画出来的东西**(用一排 `<div>` 加宽度
  //  拼成的柱状图、色块图例)。它的意思**全部**在样式里,文字一个都没有 —— 丢了样式再画,
  //  出来的是一叠没有尺寸的空 View,屏幕上**什么都看不见**。那正是「让人以为自己看到了全部」
  //  的那种谎,比不画危险。所以这两条单独拦下来,退回折叠占位(点开还能看原文):
  //  ★两条的顺序:`css-only` 在前。柱状图两条都命中,而「某个 div 装着一堆元素却一个字都没有」
  //   是更具体的诊断 —— 真机上看日志时它直接指向「模型画了个纯 CSS 的东西」。
  if (scaffolding(root)) return bad('css-only')           // 某个 div 装着元素却整棵子树无文字
  if (!root.some(renders)) return bad('no-text')          // 整段一个字都渲染不出来
  return { ok: true, nodes: root }

}

/** 这个节点**在屏幕上留得下痕迹**吗:有非空白文字,或者是一条真会画出来的分隔线。 */
function renders(n: HNode): boolean {
  if (n.t === 'text') return !!n.text.trim()
  if (n.tag === 'hr') return true
  return n.kids.some(renders)
}

/**
 * 「纯 CSS 脚手架」判定:某个 `<div>` **装着别的元素**,可整棵子树一个字都渲染不出来。
 *
 * ★只查 `div`,不查 `table` / `ul` / `p`:那几个自带结构,没文字的表格是空表格(还画得出格子),
 *  而 `div` 丢了样式之后就真的什么都不剩。柱状图的形状恰好就是这个 ——
 *  `<div class="row"><div style="width:60%"></div></div>`:外层有元素子节点、整棵无文字。
 * ★带 `<hr>` 的子树不算(`renders` 认它),`<div><hr></div>` 是一条真分隔线,该画。
 */
function scaffolding(nodes: HNode[]): boolean {
  for (const n of nodes) {
    if (n.t !== 'el') continue
    if (n.tag === 'div' && n.kids.some((k) => k.t === 'el') && !renders(n)) return true
    if (scaffolding(n.kids)) return true
  }
  return false
}

/**
 * 退回折叠占位时,右上角那句话说什么。
 *
 * ★★2026-09-03 加的,起因是用户报的一个「诡异」现象:**看的时候写着「手机端不渲染」,
 *  退出重进就画出来了**。根因不神秘 —— 代理还在流式吐字,片段的标签还没闭合
 *  (`unclosed-tag`),而那一刻占位条却言之凿凿地说「手机端不渲染」。**那是句假话**:
 *  不是画不了,是还没吐完。等吐完了自然就画出来了。
 *
 * ★所以这里按原因分成三类:
 *  · **还没吐完** —— 说「正在输出」,别说画不了;
 *  · **确实画不了** —— 说清是哪种画不了(纯样式 / 图形 / 太长 / 太深);
 *  · 其余结构性问题 —— 说「这段 HTML 结构读不懂」。
 * ★顺带:这句话现在**指得动**了。下次再遇到折叠,截图上那句话直接说明卡在哪一关,
 *  不用再去猜(上一次就是因为猜不出来,只能等下一次复现)。
 */
export function htmlFallbackNote(reason: string): string {
  if (reason === 'unclosed-tag' || reason === 'unclosed-comment' ||
      reason === 'unclosed-cdata' || reason === 'unclosed-directive') {
    return '正在输出…'
  }
  if (reason === 'css-only') return '这段是用样式画的'
  if (reason === 'empty' || reason === 'no-text') return '这段没有文字'
  if (reason === 'too-long') return '太长了'
  if (reason === 'too-deep') return '嵌套太深'
  return '结构读不懂'
}
