import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { CodeBlock, TableBlock, QuoteBlock } from './blocks'
import { MdLink } from './MdLink'
import { renderHtmlFragment, newFragmentScan, feedFragment, BLOCK_TAGS } from './htmlFragment'

// Base directory for resolving RELATIVE markdown image paths (e.g. a design doc's `![](./diagram.png)`).
// Provided by whoever renders a doc that lives on disk (FilePreview); absent in chat bubbles → relative
// images just show a placeholder rather than a broken <img>.
export const MdImageBaseCtx = createContext<string | undefined>(undefined)
const ABS_SRC = /^(https?:|data:|forge-)/i

// Markdown image. Absolute/data/protocol srcs load directly; a relative src is read from disk (relative
// to the doc's dir) via the file:image IPC → data URL, so on-disk doc images actually render.
function MdImage({ src, alt }: { src: string; alt: string }): ReactNode {
  const base = useContext(MdImageBaseCtx)
  const [url, setUrl] = useState<string | null>(() => (ABS_SRC.test(src) ? src : null))
  const [err, setErr] = useState(false)
  useEffect(() => {
    if (ABS_SRC.test(src)) { setUrl(src); setErr(false); return }
    if (!base) { setErr(true); return }
    let alive = true
    setUrl(null); setErr(false)
    void window.forge.imageFile?.(base, src)
      .then(r => { if (alive) { if (r && 'dataUrl' in r) setUrl(r.dataUrl); else setErr(true) } })
      .catch(() => { if (alive) setErr(true) })
    return () => { alive = false }
  }, [src, base])
  if (err) return <span className="md-img-err" title={src}>🖼 {alt || src}</span>
  if (!url) return <span className="md-img-loading">加载图片…</span>
  return <img className="md-img" src={url} alt={alt} />
}

// Minimal, dependency-free Markdown → React renderer for chat messages.
// Renders to React elements (never dangerouslySetInnerHTML) so CLI output can't inject HTML.
// Covers the constructs assistants actually emit: headings, bold/italic, inline code,
// fenced code blocks, ordered/unordered lists, blockquotes, horizontal rules, links.
//
// 「内嵌 HTML」(设置里可开,默认关)会额外放开一条通道:模型穿插在正文里的裸 HTML 片段交给 htmlFragment
// 处理。注意那条路同样是「解析 → 按白名单重建 React 元素」,上面那条不变量依旧成立 —— 全程没有
// dangerouslySetInnerHTML。关掉时片段原样当纯文本走老路径,行为与本功能上线前一致。

/** 是否渲染内嵌 HTML 片段(appearance.chatInlineHtml)。App 在根部提供,默认 false。 */
export const ChatHtmlCtx = createContext<boolean>(false)

// ---- inline ----------------------------------------------------------------

// 行内 HTML:提示词鼓励模型「像加粗一样穿插」,所以句子中间会出现 <span style="…">…</span>。不识别的话
// 用户会看见裸标签,所以行内也走同一套白名单(块级标签不在这里,它们由块级识别接手)。
const INLINE_HTML = /<(span|strong|b|em|i|code|small|del|sup|sub)\b[^>]*>[\s\S]*?<\/\1>/i

// 裸 URL 自动链接化。地址正文里排除掉空白、尖括号引号、中文标点和汉字 —— 模型写「打开http://x/然后」
// 时中文紧贴着地址,不排除就会把后半句话吞进链接。最后一个字符另外再排除收尾标点:「见 https://x/a。」
// 的句号属于句子;代价是真以 `)` 结尾的地址(维基百科那种)会掉一个右括号,换来的是 `(见 https://x/a)`
// 这种常见写法不吃括号 —— 后者在对话里多得多。
const URL_BODY = '\\s<>"\'`（）【】「」，。、；：！？\\u4e00-\\u9fff'
const BARE_URL = new RegExp(`https?://[^${URL_BODY}]*[^${URL_BODY}.,;:!?)\\]}]`)

// Split a run of text into inline tokens. Order matters: code first (it suppresses
// other markup inside), then links, then bold, then italic.
export function renderInline(text: string, keyBase = 'i', allowHtml = false): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let k = 0
  // Regexes are anchored at the first match of any inline construct.
  const PATTERNS: { re: RegExp; make: (m: RegExpExecArray) => ReactNode }[] = [
    { re: /`([^`]+)`/, make: m => <code key={`${keyBase}-${k++}`}>{m[1]}</code> },
    // Image BEFORE link: `![alt](src)` starts one char before the `[…](…)` a link would match, and the
    // earliest-index winner picks it — so it renders as an <img>, not a stray '!' + link.
    { re: /!\[([^\]]*)\]\(([^)\s]+)\)/, make: m => <MdImage key={`${keyBase}-${k++}`} alt={m[1]} src={m[2]} /> },
    { re: /\[([^\]]+)\]\(([^)\s]+)\)/, make: m => <MdLink key={`${keyBase}-${k++}`} href={m[2]}>{m[1]}</MdLink> },
    // 裸 URL 自动链接化。它与 code / [](…) 的优先级**不由这里的数组顺序决定** —— 下面的循环挑的是
    // 「m.index 最小」的那条规则:`` `curl http://x` `` 里 code 从反引号处命中(下标更小)所以赢,
    // `[文字](http://x)` 里链接从 `[` 处命中所以赢。两条各有一条测试钉着;把这条规则挪到数组最前面
    // 测试依然全绿(变异验证过),所以别指望靠调顺序来改优先级。
    // 结尾的收尾标点(中英文都算)剥回正文:「见 https://x/a。」里的句号属于句子,不属于地址。
    { re: BARE_URL, make: m => <MdLink key={`${keyBase}-${k++}`} href={m[0]}>{m[0]}</MdLink> },
    { re: /\*\*([^*]+)\*\*/, make: m => <strong key={`${keyBase}-${k++}`}>{renderInline(m[1], `${keyBase}b${k}`, allowHtml)}</strong> },
    { re: /__([^_]+)__/, make: m => <strong key={`${keyBase}-${k++}`}>{renderInline(m[1], `${keyBase}b${k}`, allowHtml)}</strong> },
    { re: /\*([^*]+)\*/, make: m => <em key={`${keyBase}-${k++}`}>{m[1]}</em> },
    { re: /_([^_]+)_/, make: m => <em key={`${keyBase}-${k++}`}>{m[1]}</em> },
  ]
  if (allowHtml) PATTERNS.push({ re: INLINE_HTML, make: m => renderHtmlFragment(m[0], `${keyBase}h${k++}`) })
  while (rest) {
    let best: { idx: number; len: number; node: ReactNode } | null = null
    for (const { re, make } of PATTERNS) {
      const m = re.exec(rest)
      if (m && (best === null || m.index < best.idx)) best = { idx: m.index, len: m[0].length, node: make(m) }
    }
    if (!best) { out.push(rest); break }
    if (best.idx > 0) out.push(rest.slice(0, best.idx))
    out.push(best.node)
    rest = rest.slice(best.idx + best.len)
  }
  return out
}

// ---- block -----------------------------------------------------------------

export function renderMarkdown(text: string, allowHtml = false): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  const para: string[] = []
  const inline = (t: string, kb: string): ReactNode[] => renderInline(t, kb, allowHtml)
  const flushPara = () => {
    if (!para.length) return
    const joined = para.join('\n')
    blocks.push(<p key={`p${key++}`}>{joined.split('\n').flatMap((ln, idx) => idx === 0 ? inline(ln, `p${key}-${idx}`) : [<br key={`br${key}-${idx}`} />, ...inline(ln, `p${key}-${idx}`)])}</p>)
    para.length = 0
  }

  // 有序列表连续编号计数器:LLM 常把"1. …正文… 1. …"每项都写成 1(源码就是 1、1),被中间的段落/代码块/
  // 子列表打断成多个单项 <ol> 后各自从 1 开始 → 用户看到一堆「1.」。用一个跨块的运行计数器:同一标题下的
  // 有序项连续编号(遇标题重置);显式从 >1 开始的列表(如 3. 4.)仍尊重其起始号。
  let olSeq = 0
  while (i < lines.length) {
    const line = lines[i]
    // 内嵌 HTML 块 —— 整行以一个块级标签起手。和围栏不冲突:围栏行以 ``` 开头、匹配不到这个正则,所以
    // 模型把片段包进 ```html 时仍然走下面的代码块分支(那种写法用户要的是「看代码」)。
    //
    // ★前导空白最多 3 个:第 4 个空格起在 Markdown 里就是【缩进代码块】,不是 HTML 块(CommonMark 的规矩)。
    // 原来写 ^\s* 放行任意缩进,于是「让模型读代码」时一段四空格缩进的 JSX 摘录被当成了可视化片段 ——
    // 代码摘录极少配平,进来就永远等不到闭合标签,把整条回复的后文全吞进「可视化生成中…」的折叠块里。
    const htmlOpen = allowHtml ? /^ {0,3}<([a-z][a-z0-9]*)\b/i.exec(line) : null
    if (htmlOpen && BLOCK_TAGS.has(htmlOpen[1].toLowerCase())) {
      flushPara()
      // 往后吃行,直到片段闭合。流式输出时最后一段片段是半截的(`<div style="padd`),这时不渲染 ——
      // 半截 DOM 每帧都在变,画面会抖;先摆一条占位,等模型把它写完的那一帧再换成真卡片。
      // 用增量扫描器逐行喂:每行拿整段重扫会让收集一个 N 行片段变成 O(N²)。
      const buf: string[] = []
      const scan = newFragmentScan()
      let closed = false
      while (i < lines.length) {
        buf.push(lines[i])
        if (feedFragment(scan, (buf.length > 1 ? '\n' : '') + lines[i])) { i++; closed = true; break }
        i++
      }
      const k = key++
      const raw = buf.join('\n')
      blocks.push(closed
        ? <div className="md-html" key={`html${k}`}>{renderHtmlFragment(raw, `h${k}`)}</div>
        // 未闭合:绝大多数情况是「还在流式输出中」,但也可能是模型忘了写闭合标签 —— 后者如果只显示占位,
        // 这条消息剩下的内容就永远看不到了。所以做成可展开的:平时是一行不打扰的占位,点开能看到原文,
        // 内容在任何情况下都不会丢。
        : (
          <details className="md-html-pending" key={`htmlp${k}`}>
            <summary>可视化生成中…</summary>
            <pre>{raw}</pre>
          </details>
        ))
      continue
    }
    // fenced code block —— 容忍前导缩进(LLM 常把代码块缩进到列表项下,`   ```sql` 之前的正则要求顶格 → 没
    // 识别成围栏,原样漏出反引号)。记住围栏缩进,body 各行去掉同样多的前导空白,代码不被整体右移。
    //
    // ★信息串按 CommonMark 收全(``` 之后除反引号外的任意内容),而不是只认「纯一个词」。原来的 (\w*)\s*$
    // 让 ```tsx title="App.tsx" / ```tsx:src/a.tsx 这类写法【不算围栏】,于是里面的代码原地漏出来,第一行
    // <div …> 又被上面的 HTML 分支接走 —— 引用的代码要么被渲染成活卡片,要么(摘录不配平时)把整条回复的
    // 后文吞进「可视化生成中…」。语言名取信息串的第一个词。
    const fence = /^(\s*)```([^`]*)$/.exec(line)
    if (fence) {
      flushPara()
      const indent = fence[1].length
      const strip = new RegExp('^\\s{0,' + indent + '}')
      const lang = /^[a-z0-9_+#-]+/i.exec(fence[2].trim())?.[0]
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i].replace(strip, '')); i++ }
      i++ // skip closing fence
      // 修图10:空代码块(body 全空白)不渲染——LLM 常在结尾多输出一个空围栏,渲染成"1 行"空块很干扰。
      if (body.join('').trim()) blocks.push(<CodeBlock key={`pre${key++}`} code={body.join('\n')} lang={lang} />)
      continue
    }
    // GFM table: a header row with a pipe, immediately followed by a separator
    // row of dashes/colons. Body = consecutive following lines containing a pipe.
    const SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
    if (line.includes('|') && i + 1 < lines.length && SEP.test(lines[i + 1])) {
      flushPara()
      // Split a table row into cells on the '|' that are REAL column boundaries —
      // not the pipes inside an inline `code span` and not an escaped `\|`. A naive
      // raw.split('|') shatters a cell like `a | b` (spaced pipe in backticks) into
      // extra columns; GFM also lets `\|` stand for a literal pipe. So walk the row,
      // tracking code spans, and break only on unescaped, non-code pipes.
      const splitRow = (raw: string): string[] => {
        const cells: string[] = []
        let cur = ''
        let inCode = false
        for (let p = 0; p < raw.length; p++) {
          const ch = raw[p]
          if (!inCode && ch === '\\' && raw[p + 1] === '|') { cur += '|'; p++; continue }
          if (ch === '`') { inCode = !inCode; cur += ch; continue }
          if (ch === '|' && !inCode) { cells.push(cur); cur = ''; continue }
          cur += ch
        }
        cells.push(cur)
        const trimmed = cells.map(c => c.trim())
        if (trimmed.length && trimmed[0] === '') trimmed.shift()
        if (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop()
        return trimmed
      }
      const header = splitRow(line)
      i += 2 // skip header + separator
      const body: string[][] = []
      // Consume until a blank line (GFM tables end at a blank line). A physical line that
      // is a hard-wrapped continuation of the previous row — no pipe, or fewer cells than
      // the header (a soft-wrap splits one cell across lines, e.g. "…读者身" / "份… |") —
      // folds back into the last cell instead of shattering the table into raw pipe text.
      while (i < lines.length && !/^\s*$/.test(lines[i])) {
        const cells = lines[i].includes('|') ? splitRow(lines[i]) : null
        if (cells && cells.length >= header.length) { body.push(cells); i++ }
        else if (body.length) {
          const frag = cells ? cells.join(' ') : lines[i].trim()
          const last = body[body.length - 1]
          last[last.length - 1] += ' ' + frag
          i++
        } else break
      }
      const tk = key++
      blocks.push(<TableBlock key={`tbl${tk}`} header={header} body={body} tk={tk} renderCell={inline} />)
      continue
    }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      olSeq = 0   // 新标题 = 新章节,有序编号从头开始
      const level = h[1].length
      const Tag = (`h${Math.min(level, 6)}`) as 'h1'
      blocks.push(<Tag key={`h${key++}`}>{inline(h[2], `h${key}`)}</Tag>)
      i++; continue
    }
    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara(); blocks.push(<hr key={`hr${key++}`} />); i++; continue
    }
    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++ }
      blocks.push(<ul key={`ul${key++}`}>{items.map((it, idx) => <li key={idx}>{inline(it, `ul${key}-${idx}`)}</li>)}</ul>)
      continue
    }
    // ordered list — 保留源码里的起始编号(<ol start={n}>)。这个 line-based 解析器只收「连续」的编号行,
    // 一旦某项下面跟了段落/代码块/子列表,列表就会被截断成多个单项 <ol>,每个默认从 1 开始 → 用户看到一堆
    // 「1.」。取该项自身写的数字当 start,被打断的项也显示真实序号(如 1. …正文… 2. → 显示 1、2 而非 1、1)。
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara()
      const srcNum = parseInt(line.match(/^\s*(\d+)\./)?.[1] ?? '1', 10)
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      // 源码从 1 开始(常见的"懒编号 1.") → 接着上一段有序序列继续编号;显式从 >1 开始 → 尊重其起始号。
      const start = srcNum === 1 ? olSeq + 1 : srcNum
      olSeq = start + items.length - 1
      blocks.push(<ol start={start} key={`ol${key++}`}>{items.map((it, idx) => <li key={idx}>{inline(it, `ol${key}-${idx}`)}</li>)}</ol>)
      continue
    }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      const qtext = quote.join('\n')
      blocks.push(<QuoteBlock key={`bq${key++}`} text={qtext}>{inline(qtext, `bq${key}`)}</QuoteBlock>)
      continue
    }
    // blank line → paragraph break
    if (/^\s*$/.test(line)) { flushPara(); i++; continue }
    // default: accumulate into paragraph
    para.push(line); i++
  }
  flushPara()
  return <>{blocks}</>
}

// Cross-mount parse cache. `renderMarkdown` is pure (text → React elements, which are plain reusable
// objects), but each Message unmounts/remounts on session switch, throwing away its useMemo. A small
// module-level LRU means re-entering a session — or any re-render of an unchanged message — reuses the
// parsed tree instead of re-parsing large bodies (a big part of the switch-into-a-heavy-session jank).
const PARSE_CACHE = new Map<string, ReactNode>()
const PARSE_CACHE_MAX = 240
// 缓存键必须带上 allowHtml —— 同一段原文在开关两侧解析结果不同,只按 text 缓存的话,用户在设置里切换后
// 会拿到上一次的树(而且因为命中缓存,重进会话都刷不掉)。
export function renderMarkdownCached(text: string, allowHtml = false): ReactNode {
  const ck = `${allowHtml ? 'h' : 'm'} ${text}`
  const hit = PARSE_CACHE.get(ck)
  if (hit !== undefined) {
    // Refresh LRU recency.
    PARSE_CACHE.delete(ck)
    PARSE_CACHE.set(ck, hit)
    return hit
  }
  const node = renderMarkdown(text, allowHtml)
  PARSE_CACHE.set(ck, node)
  if (PARSE_CACHE.size > PARSE_CACHE_MAX) PARSE_CACHE.delete(PARSE_CACHE.keys().next().value as string)
  return node
}

export function Markdown({ text, imageBaseCwd, allowHtml }: { text: string; imageBaseCwd?: string; allowHtml?: boolean }): ReactNode {
  // 默认跟随全局设置(App 在根部 provide);显式传 allowHtml 可以就地覆盖,给不想跟随全局开关的调用方
  // 留一个口子。
  const ctxHtml = useContext(ChatHtmlCtx)
  const html = allowHtml ?? ctxHtml
  const body = useMemo(() => renderMarkdownCached(text, html), [text, html])
  // Only wrap in a provider when a base is given (on-disk doc); chat bubbles render unchanged.
  return imageBaseCwd ? <MdImageBaseCtx.Provider value={imageBaseCwd}>{body}</MdImageBaseCtx.Provider> : body
}
