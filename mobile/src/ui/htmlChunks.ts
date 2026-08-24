/**
 * 把代理正文切成「普通文字」和「内嵌 HTML 片段」两种块。
 *
 * ★这里**不 import 任何 React Native**,就是为了能被仓库根的 vitest 直接跑。
 *  这个函数会决定「哪一段被折起来看不见」—— 判错就是把内容藏了,必须有测试钉着。
 */
/** 一段正文切成「普通文字」和「HTML 片段」两种块。 */
export type Chunk = { kind: 'text'; text: string } | { kind: 'html'; text: string }

/** 顶层块级标签开头 = 一段片段的起点。行内标签(b/i/code…)不算,那些混在文字里很正常。 */
const BLOCK_OPEN = /^[ \t]{0,3}<(div|table|section|ul|ol|figure|details|svg|dl|blockquote)\b/i

/**
 * 把正文切块。
 *
 * 判定刻意**保守**:必须是「某一行以块级开标签起头」才开始吃,而且一路吃到标签配平为止。
 * 宁可漏折(顶多还是现在这样),也不能把一段正常的回答误判成 HTML 折起来 —— 那是把内容藏起来。
 */
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
