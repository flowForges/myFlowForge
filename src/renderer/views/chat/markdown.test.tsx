import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown, renderMarkdown } from './markdown'

function html(text: string): string {
  const { container } = render(<Markdown text={text} />)
  return container.innerHTML
}

describe('Markdown', () => {
  it('renders headings', () => {
    expect(html('## 工作区项目总结')).toContain('<h2>工作区项目总结</h2>')
    expect(html('### 1. go-blog')).toContain('<h3>1. go-blog</h3>')
  })
  it('renders bold and inline code', () => {
    const out = html('**技术栈**: `Golang` 框架')
    expect(out).toContain('<strong>技术栈</strong>')
    expect(out).toContain('<code>Golang</code>')
  })
  it('renders unordered and ordered lists', () => {
    expect(html('- a\n- b')).toContain('<ul><li>a</li><li>b</li></ul>')
    expect(html('1. x\n2. y')).toContain('<ol><li>x</li><li>y</li></ol>')
  })
  it('renders fenced code blocks verbatim (no inline parsing inside)', () => {
    const out = html('```go\nfunc main() {}\n```')
    expect(out).toContain('<pre><code>func main() {}</code></pre>')
  })
  it('renders a horizontal rule and links', () => {
    expect(html('---')).toContain('<hr>')
    expect(html('[站点](https://www.iphpt.com)')).toContain('<a href="https://www.iphpt.com"')
  })
  it('separates paragraphs on blank lines', () => {
    const out = html('first\n\nsecond')
    expect(out).toContain('<p>first</p>')
    expect(out).toContain('<p>second</p>')
  })
  it('renders a GFM table with header + separator + body rows', () => {
    const { container } = render(
      <Markdown text={'| 阶段 | 内容 |\n|---|---|\n| 规划 | 设计 |\n| 开发 | 编码 |'} />,
    )
    const table = container.querySelector('table')
    expect(table).toBeTruthy()
    const ths = table!.querySelectorAll('thead th')
    expect(ths).toHaveLength(2)
    expect(ths[0].textContent).toBe('阶段')
    expect(ths[1].textContent).toBe('内容')
    const rows = table!.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    const firstCells = rows[0].querySelectorAll('td')
    expect(firstCells[0].textContent).toBe('规划')
    expect(firstCells[1].textContent).toBe('设计')
  })
  it('renders inline markup (bold/code) inside table cells', () => {
    const { container } = render(
      <Markdown text={'| 名称 | 值 |\n| --- | --- |\n| **粗** | `代码` |'} />,
    )
    expect(container.querySelector('tbody td strong')?.textContent).toBe('粗')
    expect(container.querySelector('tbody td code')?.textContent).toBe('代码')
  })
  it('renders a single-column table', () => {
    const { container } = render(
      <Markdown text={'| 项目 |\n| --- |\n| go-blog |\n| zgh |'} />,
    )
    const table = container.querySelector('table')
    expect(table).toBeTruthy()
    expect(table!.querySelectorAll('thead th')).toHaveLength(1)
    const rows = table!.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('td')?.textContent).toBe('go-blog')
    expect(rows[1].querySelector('td')?.textContent).toBe('zgh')
  })
  it('merges a hard-wrapped continuation line into the previous row cell', () => {
    // A long last cell wrapped onto a second physical line with no pipe — the
    // continuation must fold back into the row, not shatter the table into raw pipes.
    const { container } = render(
      <Markdown text={'| 名称 | 说明 |\n| --- | --- |\n| 模块 | 前台评论后台管理\n读者身份评论核心逻辑 |'} />,
    )
    const table = container.querySelector('table')
    expect(table).toBeTruthy()
    const rows = table!.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(1)
    const cells = rows[0].querySelectorAll('td')
    expect(cells).toHaveLength(2)
    expect(cells[1].textContent).toContain('前台评论后台管理')
    expect(cells[1].textContent).toContain('读者身份评论核心逻辑')
    // the continuation text must not leak out as a raw paragraph
    expect(container.querySelectorAll('p')).toHaveLength(0)
  })
  it('does NOT treat a pipe line without a separator row as a table (paragraph)', () => {
    const out = html('| a | b | c |')
    expect(out).not.toContain('<table>')
    expect(out).toContain('<p>')
    expect(out).toContain('| a | b | c |')
  })
})

describe('renderMarkdown (pure fn)', () => {
  it('returns renderable output for heading + list + fenced code block', () => {
    const text = '# Hello\n- item one\n- item two\n```js\nconsole.log(1)\n```'
    const node = renderMarkdown(text)
    const { container } = render(<>{node}</>)
    expect(container.querySelector('h1')?.textContent).toBe('Hello')
    const items = container.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toBe('item one')
    expect(items[1].textContent).toBe('item two')
    expect(container.querySelector('pre > code')?.textContent).toBe('console.log(1)')
  })
})
