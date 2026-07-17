import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

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

// A fenced code block with a hover-reveal copy button plus a fold toggle. Copying the exact source
// (not the rendered text) is what users want for commands/snippets, so the button lives on each
// block. The left-side toggle (chevron + lang + line count) collapses long blocks so a big snippet
// doesn't dominate the transcript. `lang` (the info string after ```) shows as a small label.
function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const lineCount = code.split('\n').length
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => { /* clipboard unavailable */ })
  }
  return (
    <div className={`code-block${collapsed ? ' collapsed' : ''}`}>
      <div className="cb-bar">
        <button
          className="cb-fold"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? '展开代码' : '折叠代码'}
          aria-expanded={!collapsed}
          type="button"
        >
          <svg className="cb-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          {lang ? <span className="cb-lang">{lang}</span> : null}
          <span className="cb-lines">{lineCount} 行</span>
        </button>
        <button className={`cb-copy${copied ? ' done' : ''}`} onClick={copy} title="复制代码" type="button">
          {copied ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
          )}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      {collapsed ? null : <pre><code>{code}</code></pre>}
    </div>
  )
}

// A GFM table with a hover-reveal copy button. Copying emits TSV (tab-separated cells, newline rows) —
// the raw cell source, not the rendered markup — so it pastes cleanly into spreadsheets / Notion / docs.
// The table itself sits in a horizontal-scroll wrapper so a wide table never overflows the message body.
function TableBlock({ header, body, tk }: { header: string[]; body: string[][]; tk: number }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const tsv = [header, ...body].map(r => r.join('\t')).join('\n')
    navigator.clipboard?.writeText(tsv).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => { /* clipboard unavailable */ })
  }
  return (
    <div className="table-block">
      <button className={`tbl-copy${copied ? ' done' : ''}`} onClick={copy} title="复制表格" type="button">
        {copied ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
        )}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      <div className="tbl-scroll">
        <table>
          <thead>
            <tr>{header.map((c, ci) => <th key={ci}>{renderInline(c, `th${tk}-${ci}`)}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>{row.map((c, ci) => <td key={ci}>{renderInline(c, `td${tk}-${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Minimal, dependency-free Markdown → React renderer for chat messages.
// Renders to React elements (never dangerouslySetInnerHTML) so CLI output can't inject HTML.
// Covers the constructs assistants actually emit: headings, bold/italic, inline code,
// fenced code blocks, ordered/unordered lists, blockquotes, horizontal rules, links.

// ---- inline ----------------------------------------------------------------

// Split a run of text into inline tokens. Order matters: code first (it suppresses
// other markup inside), then links, then bold, then italic.
export function renderInline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let k = 0
  // Regexes are anchored at the first match of any inline construct.
  const PATTERNS: { re: RegExp; make: (m: RegExpExecArray) => ReactNode }[] = [
    { re: /`([^`]+)`/, make: m => <code key={`${keyBase}-${k++}`}>{m[1]}</code> },
    // Image BEFORE link: `![alt](src)` starts one char before the `[…](…)` a link would match, and the
    // earliest-index winner picks it — so it renders as an <img>, not a stray '!' + link.
    { re: /!\[([^\]]*)\]\(([^)\s]+)\)/, make: m => <MdImage key={`${keyBase}-${k++}`} alt={m[1]} src={m[2]} /> },
    { re: /\[([^\]]+)\]\(([^)\s]+)\)/, make: m => <a key={`${keyBase}-${k++}`} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a> },
    { re: /\*\*([^*]+)\*\*/, make: m => <strong key={`${keyBase}-${k++}`}>{renderInline(m[1], `${keyBase}b${k}`)}</strong> },
    { re: /__([^_]+)__/, make: m => <strong key={`${keyBase}-${k++}`}>{renderInline(m[1], `${keyBase}b${k}`)}</strong> },
    { re: /\*([^*]+)\*/, make: m => <em key={`${keyBase}-${k++}`}>{m[1]}</em> },
    { re: /_([^_]+)_/, make: m => <em key={`${keyBase}-${k++}`}>{m[1]}</em> },
  ]
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

export function renderMarkdown(text: string): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  const para: string[] = []
  const flushPara = () => {
    if (!para.length) return
    const joined = para.join('\n')
    blocks.push(<p key={`p${key++}`}>{joined.split('\n').flatMap((ln, idx) => idx === 0 ? renderInline(ln, `p${key}-${idx}`) : [<br key={`br${key}-${idx}`} />, ...renderInline(ln, `p${key}-${idx}`)])}</p>)
    para.length = 0
  }

  while (i < lines.length) {
    const line = lines[i]
    // fenced code block
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      flushPara()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++ }
      i++ // skip closing fence
      blocks.push(<CodeBlock key={`pre${key++}`} code={body.join('\n')} lang={fence[1] || undefined} />)
      continue
    }
    // GFM table: a header row with a pipe, immediately followed by a separator
    // row of dashes/colons. Body = consecutive following lines containing a pipe.
    const SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
    if (line.includes('|') && i + 1 < lines.length && SEP.test(lines[i + 1])) {
      flushPara()
      // Split a table row on '|', trim, and drop empty cells from outer pipes.
      const splitRow = (raw: string): string[] => {
        const cells = raw.split('|').map(c => c.trim())
        if (cells.length && cells[0] === '') cells.shift()
        if (cells.length && cells[cells.length - 1] === '') cells.pop()
        return cells
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
      blocks.push(<TableBlock key={`tbl${tk}`} header={header} body={body} tk={tk} />)
      continue
    }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      const level = h[1].length
      const Tag = (`h${Math.min(level, 6)}`) as 'h1'
      blocks.push(<Tag key={`h${key++}`}>{renderInline(h[2], `h${key}`)}</Tag>)
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
      blocks.push(<ul key={`ul${key++}`}>{items.map((it, idx) => <li key={idx}>{renderInline(it, `ul${key}-${idx}`)}</li>)}</ul>)
      continue
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      blocks.push(<ol key={`ol${key++}`}>{items.map((it, idx) => <li key={idx}>{renderInline(it, `ol${key}-${idx}`)}</li>)}</ol>)
      continue
    }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      blocks.push(<blockquote key={`bq${key++}`}>{renderInline(quote.join('\n'), `bq${key}`)}</blockquote>)
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
export function renderMarkdownCached(text: string): ReactNode {
  const hit = PARSE_CACHE.get(text)
  if (hit !== undefined) {
    // Refresh LRU recency.
    PARSE_CACHE.delete(text)
    PARSE_CACHE.set(text, hit)
    return hit
  }
  const node = renderMarkdown(text)
  PARSE_CACHE.set(text, node)
  if (PARSE_CACHE.size > PARSE_CACHE_MAX) PARSE_CACHE.delete(PARSE_CACHE.keys().next().value as string)
  return node
}

export function Markdown({ text, imageBaseCwd }: { text: string; imageBaseCwd?: string }): ReactNode {
  const body = useMemo(() => renderMarkdownCached(text), [text])
  // Only wrap in a provider when a base is given (on-disk doc); chat bubbles render unchanged.
  return imageBaseCwd ? <MdImageBaseCtx.Provider value={imageBaseCwd}>{body}</MdImageBaseCtx.Provider> : body
}
