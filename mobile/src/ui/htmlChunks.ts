/**
 * 把代理正文切成「普通文字」和「内嵌 HTML 片段」两种块。
 *
 * ★这里**不 import 任何 React Native**,就是为了能被仓库根的 vitest 直接跑。
 *  这个函数会决定「哪一段被折起来看不见」—— 判错就是把内容藏了,必须有测试钉着。
 */
/** 一段正文切成「普通文字」和「HTML 片段」两种块。 */
export type Chunk = { kind: 'text'; text: string } | { kind: 'html'; text: string }

/**
 * 顶层块级标签开头 = 一段片段的起点。行内标签(b/i/code…)不算,那些混在文字里很正常。
 *
 * ★★这份名单和 `htmlParse.ts` 画得出来的东西**必须对得上**,`htmlChunks.test.ts` 里有一条
 *  断言逐个跑一遍。2026-09-03 之前它俩是打架的:`section` / `figure` / `details` / `dl`
 *  在这儿是「片段起点」,而解析那边白名单里一个都没有 ⇒ 这四种**每次都被折起来**,
 *  100% 触发「手机端不渲染」。两处各写一份名单、谁都没钉住对方,就是这么烂掉的。
 *
 * ★`svg` 留着是**有意的**:它在解析那边是「整棵丢掉」,于是一段纯 svg 会解析成空 ⇒ 退回折叠
 *  占位,标题写着「图形 · N 行 HTML」。那句话是诚实的 —— 我们确实画不了矢量图。
 * ★`p` / `h1..h6` / `pre` 是 2026-09-03 补的:代理经常直接从 `<p>` 或 `<h2>` 起手,
 *  而这些行原来会掉进 markdown 那条路、把标签原样显示成文字。
 */
const BLOCK_OPEN =
  /^[ \t]{0,3}<(div|table|section|article|ul|ol|figure|details|dl|blockquote|p|pre|h[1-6]|html|main|header|footer|aside|nav|svg)\b/i

/**
 * 把正文切块。
 *
 * 判定刻意**保守**:必须是「某一行以块级开标签起头」才开始吃,而且一路吃到标签配平为止。
 * 宁可漏折(顶多还是现在这样),也不能把一段正常的回答误判成 HTML 折起来 —— 那是把内容藏起来。
 */
/** 只给测试用:把上面那条正则里的标签名摊出来,好逐个验「切出来的块解析器画得动」。 */
export const BLOCK_OPEN_TAGS: readonly string[] = [
  'div', 'table', 'section', 'article', 'ul', 'ol', 'figure', 'details', 'dl', 'blockquote',
  'p', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'html', 'main', 'header', 'footer', 'aside', 'nav', 'svg',
]

export function splitHtmlChunks(src: string): Chunk[] {
  const lines = src.split('\n')
  const out: Chunk[] = []
  let buf: string[] = []
  const flushText = () => {
    if (buf.length) out.push({ kind: 'text', text: buf.join('\n') })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    if (!BLOCK_OPEN.test(lines[i])) {
      buf.push(lines[i])
      continue
    }
    // 找到配平点。只数同名标签的开合,数不平就一直吃到结尾 —— 代理被打断时片段本来就可能没闭合。
    const tag = BLOCK_OPEN.exec(lines[i])![1].toLowerCase()
    const open = new RegExp(`<${tag}\\b`, 'gi')
    const close = new RegExp(`</${tag}\\s*>`, 'gi')
    let depth = 0
    let j = i
    for (; j < lines.length; j++) {
      depth += (lines[j].match(open) ?? []).length
      depth -= (lines[j].match(close) ?? []).length
      if (depth <= 0) break
    }
    const end = Math.min(j, lines.length - 1)
    flushText()
    out.push({ kind: 'html', text: lines.slice(i, end + 1).join('\n') })
    i = end
  }
  flushText()
  // 前后的空行在切块时会留下一堆空 text 块,清掉。
  return out.filter((c) => c.kind === 'html' || c.text.trim() !== '')
}
