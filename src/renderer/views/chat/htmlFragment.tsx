import { createElement, Fragment } from 'react'
import type { ReactNode } from 'react'

import { mapInlineStyle } from './htmlStyle'
import { CodeBlock, TableBlock } from './blocks'

// 把一段文本交回 Markdown 渲染。由 markdown.tsx 注入 —— 反过来 import 会成环。
export type MdRenderer = (text: string) => ReactNode

// 内嵌 HTML 片段 → React 元素。
//
// 打开「内嵌 HTML」后,模型会在 Markdown 正文里穿插裸 HTML 片段(对比矩阵、流程结构、信息卡片)。这里负责
// 把它变成能安全渲染的 React 元素。
//
// ★ 为什么是「解析 → 按白名单重建」而不是「净化 → innerHTML」:
//   markdown.tsx 一直有一条不变量 ——「只输出 React 元素,从不 dangerouslySetInnerHTML,所以 CLI 输出无法
//   注入 HTML」。这条不变量在这里**完全不用破**:用 DOMParser 拿到一棵惰性树(规范保证它不执行脚本、不加载
//   子资源),然后只用 createElement 把白名单内的标签造回来。不在名单上的标签属性不是「被洗掉」,而是压根
//   没有代码路径能把它构造出来 —— 白名单是构造性的,不是过滤性的。
//
// ★ 为什么这层是唯一的安全边界:
//   渲染页没有 CSP,而 window.forge(全部 IPC:读文件、起 agent、改设置)经 contextBridge 暴露在**主世界**,
//   和 React 同一个世界。CLI agent 的输出里夹带着它读到的仓库文件/网页内容,是不可信输入。提示词只是请求,
//   模型不听话或被注入时,兜底全在这里。参考文章的提示词甚至允许模型输出 <script>,本实现不采纳。

// 允许构造的标签。刻意不含 <img>/<a>:远程 src 在 Electron 里是追踪信标 + 泄露出口 IP,href 有
// javascript: 面。图片和链接走 Markdown 语法 —— 那条路已经有从磁盘加载图片的 IPC 和 rel="noreferrer"。
const TAGS = new Set([
  'div', 'span', 'p', 'br', 'hr',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'details', 'summary',
  'strong', 'b', 'em', 'i', 'code', 'pre', 'small', 'del', 'sup', 'sub',
  'h3', 'h4', 'h5', 'h6',
])

// 这些标签连同**整棵子树**丢弃 —— 它们的文本内容是代码/元数据,不是给人读的正文,保留下来只会漏出一堆
// JS 源码。其它未知标签走「拆掉标签、保留子节点」的路子,避免正文凭空消失。
const DROP_SUBTREE = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'option',
  'textarea', 'link', 'meta', 'base', 'title', 'noscript', 'template', 'svg', 'math', 'canvas',
  'audio', 'video', 'source', 'track', 'applet', 'frame', 'frameset', 'portal', 'slot',
])

// 自闭合标签:React 不允许给它们传 children。
const VOID_TAGS = new Set(['br', 'hr'])

// 块级标签 —— 一行以它们开头才当作「HTML 块」。行内标签(span/strong/…)只在段落内部识别。
export const BLOCK_TAGS = new Set(['div', 'table', 'details', 'ul', 'ol', 'p', 'pre', 'blockquote', 'section', 'article'])

const MAX_DEPTH = 24   // 病态嵌套的兜底,正常片段远达不到

// ---- 属性 -------------------------------------------------------------------

function propsFor(el: Element, key: string): Record<string, unknown> {
  const props: Record<string, unknown> = { key }
  const style = el.getAttribute('style')
  if (style) {
    const mapped = mapInlineStyle(style)
    if (Object.keys(mapped).length) props['style'] = mapped
  }
  // 只有表格跨格属性额外放行。其余(class/id/href/src/on*/data-*/…)白名单里没有。
  const tag = el.tagName.toLowerCase()
  if (tag === 'th' || tag === 'td') {
    for (const [attr, prop] of [['colspan', 'colSpan'], ['rowspan', 'rowSpan']] as const) {
      const raw = el.getAttribute(attr)
      if (!raw) continue
      const n = parseInt(raw, 10)
      if (Number.isFinite(n) && n > 1 && n <= 100) props[prop] = n
    }
  }
  return props
}

// ---- 表格 / 代码块提升 -------------------------------------------------------

// 「朴素表格」= 没有跨行跨列、行列整齐。只有这种才提升成 TableBlock —— 否则抽成 string[][] 会丢结构。
function plainTableData(el: Element): { header: string[]; body: string[][] } | null {
  if (el.querySelector('table')) return null                                  // 嵌套表格,不碰
  if (el.querySelector('[colspan],[rowspan]')) return null                    // 合并单元格,不碰
  const rows = Array.from(el.querySelectorAll('tr'))
  if (rows.length < 2) return null
  const cellsOf = (tr: Element): string[] =>
    Array.from(tr.querySelectorAll('th,td')).map(c => (c.textContent ?? '').trim())
  const header = cellsOf(rows[0])
  if (!header.length) return null
  const body = rows.slice(1).map(cellsOf)
  if (body.some(r => r.length !== header.length)) return null                 // 列数不齐,不碰
  return { header, body }
}

// ---- 节点 → React -----------------------------------------------------------

// 允许「内容交回 Markdown 重新解析」的容器。只挑嵌块级元素合法的那几个:往 <p> 里塞 <p>/<pre> 会造出
// 非法嵌套。CommonMark 的规矩是 HTML 块遇空行就结束、之后重新按 Markdown 解析,GitHub 渲染 <details>
// 里的正文正是这样 —— 模型也正是冲着这条规矩才在 <summary> 后面空一行。
const MD_REENTRY = new Set(['div', 'details', 'li', 'td', 'th'])

function renderNode(node: Node, key: string, depth: number, md: MdRenderer | undefined, mdHere: boolean): ReactNode {
  if (depth > MAX_DEPTH) return null
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const t = node.nodeValue ?? ''
    if (!t) return null
    // 空行 = 这段 raw HTML 到此为止,后面是 Markdown。不含空行的文本段(卡片里的一句话)保持原样,
    // 免得把纯 HTML 卡片拆成一堆 <p>。
    if (mdHere && md && /\n[ \t]*\n/.test(t)) return <Fragment key={key}>{md(t)}</Fragment>
    return t
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return null   // 注释、CDATA 等一律丢

  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (DROP_SUBTREE.has(tag)) return null

  const kids = (): ReactNode[] =>
    Array.from(el.childNodes)
      .map((c, i) => renderNode(c, `${key}-${i}`, depth + 1, md, MD_REENTRY.has(tag)))
      .filter(c => c !== null)

  // 未知标签:拆掉标签本身,保留子节点 —— 内容不该因为一个没见过的容器就整段消失。
  if (!TAGS.has(tag)) return kids()

  // 提升:模型即使被提示词劝过还是写了 <table>/<pre>,也让它拿到排序/复制/折叠 —— 表格和代码块的行为
  // 不该取决于内容是从 Markdown 来还是从 HTML 来。抽不动就回退成普通白名单节点。
  if (tag === 'table') {
    const data = plainTableData(el)
    if (data) return <TableBlock key={key} tk={key} header={data.header} body={data.body} />
  }
  if (tag === 'pre') {
    const code = (el.textContent ?? '').replace(/\n$/, '')
    if (code.trim()) return <CodeBlock key={key} code={code} />
  }

  if (VOID_TAGS.has(tag)) return createElement(tag, propsFor(el, key))
  return createElement(tag, propsFor(el, key), ...kids())
}

// ---- 入口 -------------------------------------------------------------------

/**
 * 把一段 HTML 片段渲染成 React 节点。解析用 DOMParser(惰性,不执行脚本、不加载子资源),
 * 重建只走标签/属性白名单。任何情况下都不会 dangerouslySetInnerHTML。
 */
export function renderHtmlFragment(html: string, keyBase = 'h', md?: MdRenderer): ReactNode {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html   // 解析不了就当纯文本,总好过白屏
  }
  const out = Array.from(doc.body.childNodes)
    .map((n, i) => renderNode(n, `${keyBase}-${i}`, 0, md, true))
    .filter(n => n !== null)
  return <>{out}</>
}

// 片段闭合判定。流式输出时片段是半截的(`<div style="padd`),这时候渲染出来的 DOM 每帧都在变,画面会抖
// —— 调用方据此先显示占位,等闭合了再换成真卡片。
//
// 判据是「开合标签计数配平」而不是「以 > 结尾」:后者对 `<div><span></span>` 这种会误判成完整。
//
// 做成增量扫描器而不是「每次拿整段重扫」:块级识别是逐行喂进来的,一次性接口会让收集一个 N 行片段变成
// O(N²) 的重复扫描。大片段(模型偶尔会吐几百行)在这条路上会明显卡顿。

/** 增量扫描状态。`pending` 只存「最后一个完整标签之后的残余文本」,长度有界。 */
export interface FragmentScan { stack: string[]; pending: string; broken: boolean }
export function newFragmentScan(): FragmentScan { return { stack: [], pending: '', broken: false } }

const TAG_RE = /<\/?([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi

/** 喂一段新文本,返回「到目前为止是否已闭合」。 */
export function feedFragment(scan: FragmentScan, chunk: string): boolean {
  const buf = scan.pending + chunk
  TAG_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(buf)) !== null) {
    last = m.index + m[0].length
    const tag = m[1].toLowerCase()
    if (VOID_TAGS.has(tag) || m[2] === '/') continue      // 自闭合不入栈
    if (m[0][1] === '/') {
      const at = scan.stack.lastIndexOf(tag)
      if (at < 0) { scan.broken = true; continue }        // 闭标签没有对应的开标签
      scan.stack.length = at                              // 容忍中间未闭合的标签(HTML 的宽松语义)
    } else scan.stack.push(tag)
  }
  // 残余 = 最后一个完整标签之后的文本。属性值里的 `>` 会让上面的正则提前截断,但那只会让判定偏保守
  // (判成未闭合 → 多显示一帧占位),不会误判成已闭合,方向是安全的。
  scan.pending = buf.slice(last)
  if (scan.broken || scan.stack.length) return false
  // 上面只看「完整的标签」。流式最常见的一帧其实是标签本身就没写完(`<div style="padd`)—— 它一个完整
  // 标签都匹配不到,栈是空的,会被误判成已闭合。所以再查残余里有没有开了头没收尾的 `<tag`。
  return !/<\/?[a-z]/i.test(scan.pending)
}

/** 一次性判定(测试与单段调用用);逐行收集请用 newFragmentScan + feedFragment,避免 O(N²)。 */
export function isFragmentClosed(html: string): boolean {
  return feedFragment(newFragmentScan(), html)
}
