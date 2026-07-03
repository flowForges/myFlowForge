import { useMemo } from 'react'
import type { ReactNode } from 'react'

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
      blocks.push(<pre key={`pre${key++}`}><code>{body.join('\n')}</code></pre>)
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
      blocks.push(
        <table key={`tbl${tk}`}>
          <thead>
            <tr>{header.map((c, ci) => <th key={ci}>{renderInline(c, `th${tk}-${ci}`)}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>{row.map((c, ci) => <td key={ci}>{renderInline(c, `td${tk}-${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      )
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

export function Markdown({ text }: { text: string }): ReactNode {
  return useMemo(() => renderMarkdown(text), [text])
}
