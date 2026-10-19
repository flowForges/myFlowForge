import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Markdown, renderMarkdownCached, mdParser } from './markdown'

afterEach(() => { vi.restoreAllMocks(); cleanup() })

const settled = (text: string, allowHtml = false): string =>
  render(<Markdown text={text} allowHtml={allowHtml} />).container.innerHTML

/** 把 full 按 step 个字符一段地「流」进同一个 <Markdown streaming>,每一帧都和非流式渲染逐字比对。 */
function streamAndCompare(full: string, step: number, allowHtml = false): void {
  const host = render(<Markdown text="" streaming allowHtml={allowHtml} />)
  for (let n = step; n < full.length + step; n += step) {
    const part = full.slice(0, Math.min(n, full.length))
    host.rerender(<Markdown text={part} streaming allowHtml={allowHtml} />)
    const live = host.container.innerHTML
    const ref = render(<Markdown text={part} allowHtml={allowHtml} />)
    expect(live, `prefix ${part.length}`).toBe(ref.container.innerHTML)
    ref.unmount()
  }
  host.rerender(<Markdown text={full} allowHtml={allowHtml} />)
  expect(host.container.innerHTML).toBe(settled(full, allowHtml))
}

const DOC = [
  '## 标题一', '', '1. 第一项', '', '一段正文 **加粗** 和 `code`', '第二行', '', '1. 接续编号',
  '', '- a', '- b', '', '| h1 | h2 |', '|---|---|', '| x | y |', '续行', '', '> 引用', '> 第二行',
  '', '```ts', 'const a = 1', '', 'const b = 2', '```', '', '---', '', '## 标题二', '1. 重置编号',
  // 未闭合围栏的「表格兜底」读到文末才决定回退 —— 之后围栏真的闭合了,前面按兜底切出来的块必须作废。
  '', '```', '| 被吞 | 表格 |', '|---|---|', '| 1 | 2 |', '', '围栏里的一段', '', '又一段', '```', '', '收尾',
].join('\n')

describe('流式 Markdown —— 输出与非流式一致', () => {
  it('每一帧与整段解析逐字相同,流完后与非流式渲染相同', () => {
    streamAndCompare(DOC, 3)
    streamAndCompare(DOC, 17)
  })
  it('内嵌 HTML 模式同样一致(未闭合片段占位 → 闭合后变真卡片)', () => {
    const src = '前言\n\n<div style="padding:4px">\n\n卡片 **内容**\n\n</div>\n\n结论。<div>\n尾巴\n</div>\n\n1. 收尾'
    streamAndCompare(src, 2, true)
  })
  it.each([
    ['列表', '- a\n- b\n\nx', '- a\n- b\n- c'],
    ['引用', '> a\n> b\n\nx', '> a\n> b\n> c'],
    ['表格', '| h | k |\n|---|---|\n| 1 | 2 |\n\nx', '| h | k |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'],
  ])('★ 流式中途改写了可续点那一行(assistant-replace)—— %s 不能复用按旧行收尾的块', (_n, before, after) => {
    const host = render(<Markdown text={before} streaming />)
    host.rerender(<Markdown text={after} streaming />)
    expect(host.container.innerHTML).toBe(settled(after))
  })
  it('非前缀式改写(文本被整体替换)时退回整段解析,结果仍正确', () => {
    const host = render(<Markdown text={'- a\n- b\n\n段落一\n\n段落二'} streaming />)
    host.rerender(<Markdown text={'# 全新\n\n1. x\n\n正文'} streaming />)
    expect(host.container.innerHTML).toBe(settled('# 全新\n\n1. x\n\n正文'))
  })
})

describe('流式 Markdown —— 解析缓存', () => {
  it('★ 生成中的半截文本不进模块级缓存;流完的终稿照常缓存', () => {
    const full = Array.from({ length: 6 }, (_, k) => `第 ${k} 段 unique-cache-probe`).join('\n\n')
    const host = render(<Markdown text="" streaming />)
    const partials: string[] = []
    for (let n = 5; n < full.length; n += 5) {
      partials.push(full.slice(0, n))
      host.rerender(<Markdown text={full.slice(0, n)} streaming />)
    }
    host.rerender(<Markdown text={full} />)
    const spy = vi.spyOn(mdParser, 'parseBlocks')
    // 终稿命中缓存 → 不再解析
    renderMarkdownCached(full)
    expect(spy).not.toHaveBeenCalled()
    // 任何一段半截文本都没进缓存 → 每次都是一次新解析
    for (const p of partials.slice(0, 5)) {
      spy.mockClear()
      renderMarkdownCached(p + '\u0000') // 先确认探针手段本身:未缓存的必解析
      expect(spy).toHaveBeenCalled()
      spy.mockClear()
      renderMarkdownCached(p)
      expect(spy, `partial len ${p.length} was cached`).toHaveBeenCalled()
    }
  })
})

describe('流式 Markdown —— 解析量随增量线性增长', () => {
  it('N 次增量累计解析的字符数 ~ O(总长),而不是 O(N × 总长)', () => {
    const paras = Array.from({ length: 200 }, (_, k) => `第 ${k} 段:一些正文 **加粗** \`code\` 结束。`)
    const full = paras.join('\n\n')
    const spy = vi.spyOn(mdParser, 'parseBlocks')
    const host = render(<Markdown text="" streaming />)
    let deltas = 0
    for (let n = 8; n < full.length + 8; n += 8) {
      host.rerender(<Markdown text={full.slice(0, Math.min(n, full.length))} streaming />)
      deltas++
    }
    const parsedChars = spy.mock.calls.reduce((s, c) => s + (c[0] as string).length, 0)
    expect(deltas).toBeGreaterThan(500)
    // 每次只重解析末尾那一两个块(≤ ~100 字符);整段重解析会是 ~deltas × full.length / 2 ≈ 百万级。
    expect(parsedChars).toBeLessThan(deltas * 120)
    expect(parsedChars).toBeLessThan(full.length * 15)
  })
})
