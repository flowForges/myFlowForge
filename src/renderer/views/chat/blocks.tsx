import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { highlightBlock } from '../inspector/highlight'

// 对话区的「块级组件」:代码块、表格、引用块。
//
// 从 markdown.tsx 抽出来独立成模块,是因为内嵌 HTML 通道(htmlFragment.tsx)也要复用它们 —— 模型在 HTML
// 片段里写的 <table>/<pre> 会被提升成这里的组件,好让「表格能排序能复制、代码块能折叠能复制」这件事
// 与内容来自 Markdown 还是 HTML 无关。留在 markdown.tsx 里会让两个模块互相 import 成环。
//
// 这里刻意不 import renderInline:TableBlock 用 renderCell 回调把单元格渲染交还给调用方(markdown.tsx
// 传 renderInline;HTML 通道传纯文本),这样依赖是单向的。

// ---- 复制按钮 ---------------------------------------------------------------

const ICON_CHECK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="20 6 9 17 4 12" /></svg>
const ICON_COPY = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>

/** hover 显形的复制按钮。`text` 惰性求值 —— 表格要复制「当前排序后」的内容,不能在渲染时就算死。 */
export function CopyButton({ text, className, title }: { text: () => string; className: string; title: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    navigator.clipboard?.writeText(text()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => { /* clipboard unavailable */ })
  }
  return (
    <button className={`${className}${copied ? ' done' : ''}`} onClick={copy} title={title} type="button">
      {copied ? ICON_CHECK : ICON_COPY}
      <span>{copied ? '已复制' : '复制'}</span>
    </button>
  )
}

// ---- 代码块 -----------------------------------------------------------------

// A fenced code block with a hover-reveal copy button plus a fold toggle. Copying the exact source
// (not the rendered text) is what users want for commands/snippets, so the button lives on each
// block. The left-side toggle (chevron + lang + line count) collapses long blocks so a big snippet
// doesn't dominate the transcript. `lang` (the info string after ```) shows as a small label.
export function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  const [collapsed, setCollapsed] = useState(false)
  const lineCount = code.split('\n').length
  // 语法着色:交给 highlight.ts 的整块分词器,拿回来的 token 逐个包成 <span class="t-xx">,颜色全部走
  // chat.css 里的 --syn-* 变量(跟着主题/皮肤走)。没写语言的围栏 / 超长块会原样返回一个纯文本 token,
  // 所以这里不需要额外分支。useMemo:同一条消息重渲染(流式追加、切会话)时不重复分词。
  const tokens = useMemo(() => highlightBlock(code, lang), [code, lang])
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
        <CopyButton className="cb-copy" title="复制代码" text={() => code} />
      </div>
      {/* <pre> 对空白敏感,token 数组必须紧贴标签写在一行里,不能让 JSX 的换行缩进混进代码正文。 */}
      {collapsed ? null : <pre><code>{tokens.map((t, idx) => t.cls === null ? t.text : <span key={idx} className={`t-${t.cls}`}>{t.text}</span>)}</code></pre>}
    </div>
  )
}

// ---- 表格 -------------------------------------------------------------------

export type SortDir = 'asc' | 'desc'
export type SortState = { col: number; dir: SortDir } | null

// 一列是不是「数值列」:非空单元格全部能读成数字才算。否则 "10" 会排在 "9" 前面。容忍千分位逗号、
// 百分号和货币符号 —— 模型很爱写 `1,234` / `85%` / `$99`。
const NUM = /^[+-]?[\d,]*\.?\d+%?$/
export function asNumber(cell: string): number | null {
  const t = cell.trim().replace(/^[$¥€£]/, '')
  if (!t || !NUM.test(t)) return null
  const n = parseFloat(t.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
export function isNumericColumn(body: string[][], col: number): boolean {
  const vals = body.map(r => r[col] ?? '').filter(c => c.trim() !== '')
  return vals.length > 0 && vals.every(c => asNumber(c) !== null)
}

/**
 * 按某列排序。数值列按数值比,否则按 localeCompare('zh')(中文要按拼音而不是码点)。
 * 稳定排序:Array.prototype.sort 在现代引擎里已保证稳定,所以同值行保持原有相对次序。
 */
export function sortRows(body: string[][], sort: SortState): string[][] {
  if (!sort) return body
  const { col, dir } = sort
  const numeric = isNumericColumn(body, col)
  const sign = dir === 'asc' ? 1 : -1
  return [...body].sort((a, b) => {
    const x = a[col] ?? '', y = b[col] ?? ''
    // 空单元格一律沉底,不参与升降 —— 否则一列里的空洞会把有内容的行挤走。
    if (x.trim() === '' && y.trim() === '') return 0
    if (x.trim() === '') return 1
    if (y.trim() === '') return -1
    if (numeric) return ((asNumber(x) ?? 0) - (asNumber(y) ?? 0)) * sign
    return x.localeCompare(y, 'zh') * sign
  })
}

/** 点表头的三态循环:原序 → 升 → 降 → 原序。原序要留着,因为模型往往是精心排过的。 */
export function nextSort(cur: SortState, col: number): SortState {
  if (!cur || cur.col !== col) return { col, dir: 'asc' }
  if (cur.dir === 'asc') return { col, dir: 'desc' }
  return null
}

// A GFM table with sortable headers and a hover-reveal copy button. Copying emits TSV (tab-separated
// cells, newline rows) — the raw cell source, not the rendered markup — so it pastes cleanly into
// spreadsheets / Notion / docs, and it follows the CURRENT sort so what you copy is what you see.
// The table itself sits in a horizontal-scroll wrapper so a wide table never overflows the message body.
export function TableBlock({ header, body, tk, renderCell }: {
  header: string[]
  body: string[][]
  tk: number | string
  renderCell?: (text: string, key: string) => ReactNode
}): ReactNode {
  const [sort, setSort] = useState<SortState>(null)
  const rows = useMemo(() => sortRows(body, sort), [body, sort])
  const cell = renderCell ?? ((t: string) => t)
  return (
    <div className="table-block">
      <CopyButton
        className="tbl-copy"
        title="复制表格"
        text={() => [header, ...rows].map(r => r.join('\t')).join('\n')}
      />
      <div className="tbl-scroll">
        <table>
          <thead>
            <tr>
              {header.map((c, ci) => {
                const active = sort?.col === ci
                return (
                  <th
                    key={ci}
                    className={`tbl-th${active ? ` sorted-${sort.dir}` : ''}`}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button className="tbl-sort" type="button" onClick={() => setSort(s => nextSort(s, ci))}
                      title={active ? (sort.dir === 'asc' ? '改为降序' : '恢复原序') : '按此列升序'}>
                      <span>{cell(c, `th${tk}-${ci}`)}</span>
                      <svg className="tbl-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                        <polyline points="7 10 12 5 17 10" /><polyline points="7 14 12 19 17 14" />
                      </svg>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>{row.map((c, ci) => <td key={ci}>{cell(c, `td${tk}-${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---- 引用块 -----------------------------------------------------------------

// 引用块也给一个复制按钮(和代码块/表格一致的 hover 显形)。复制的是纯文本 —— 不带 `>` 标记,因为用户
// 要的是被引用的内容本身,而不是它的 Markdown 外壳。
export function QuoteBlock({ text, children }: { text: string; children: ReactNode }): ReactNode {
  return (
    <div className="quote-block">
      <CopyButton className="bq-copy" title="复制引用" text={() => text} />
      <blockquote>{children}</blockquote>
    </div>
  )
}
