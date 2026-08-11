import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown, ChatHtmlCtx } from './markdown'

const on = (text: string): HTMLElement => render(<Markdown text={text} allowHtml />).container
const off = (text: string): HTMLElement => render(<Markdown text={text} />).container

describe('内嵌 HTML —— 开关', () => {
  it('★ 关掉时片段原样当纯文本,行为与本功能上线前一致', () => {
    const c = off('<div style="display:flex">卡片</div>')
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.textContent).toContain('<div style="display:flex">卡片</div>')
  })
  it('打开时片段被渲染成真元素', () => {
    const c = on('<div style="display:flex">卡片</div>')
    expect(c.querySelector('.md-html')).toBeTruthy()
    expect(c.textContent).toBe('卡片')
  })
  it('默认跟随 context(未提供时为关)', () => {
    const c = render(<Markdown text={'<div>卡片</div>'} />).container
    expect(c.querySelector('.md-html')).toBeNull()
  })
  it('context 打开后无需传 prop 也渲染', () => {
    const c = render(<ChatHtmlCtx.Provider value={true}><Markdown text={'<div>卡片</div>'} /></ChatHtmlCtx.Provider>).container
    expect(c.querySelector('.md-html')).toBeTruthy()
  })
  it('★ 同一段原文在开关两侧结果不同 —— 解析缓存必须把开关算进键里', () => {
    const src = '<div>同一段原文</div>'
    expect(off(src).querySelector('.md-html')).toBeNull()
    expect(on(src).querySelector('.md-html')).toBeTruthy()
    expect(off(src).querySelector('.md-html')).toBeNull()   // 再切回去仍然是纯文本,没被缓存串味
  })
})

describe('内嵌 HTML —— 与 Markdown 混排', () => {
  it('片段前后的 Markdown 照常渲染', () => {
    const c = on('## 标题\n\n<div style="padding:8px">卡片</div>\n\n正文**加粗**')
    expect(c.querySelector('h2')?.textContent).toBe('标题')
    expect(c.querySelector('.md-html')).toBeTruthy()
    expect(c.querySelector('strong')?.textContent).toBe('加粗')
  })
  it('行内片段穿插在句子中间', () => {
    const c = on('这里是 <span style="color:#d97706">强调</span> 后面继续。')
    expect(c.querySelector('p span')).toBeTruthy()
    expect(c.textContent).toBe('这里是 强调 后面继续。')
  })
  it('```html 围栏仍然渲染成代码块(那种写法用户要的是看代码)', () => {
    const c = on('```html\n<div>不要渲染我</div>\n```')
    expect(c.querySelector('.code-block')).toBeTruthy()
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.querySelector('pre > code')?.textContent).toBe('<div>不要渲染我</div>')
  })
  it('Markdown 表格不受影响,仍然可排序可复制', () => {
    const c = on('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(c.querySelector('.table-block')).toBeTruthy()
    expect(c.querySelector('.tbl-copy')).toBeTruthy()
    expect(c.querySelectorAll('.tbl-sort')).toHaveLength(2)
  })
  it('多个片段各自成块', () => {
    const c = on('<div>一</div>\n\n中间\n\n<div>二</div>')
    expect(c.querySelectorAll('.md-html')).toHaveLength(2)
    expect(c.textContent).toContain('中间')
  })
  it('普通段落里的 < 不会被当成 HTML', () => {
    const c = on('如果 a < b 那么继续')
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.textContent).toContain('a < b')
  })
  it('非块级标签起手的行不当作 HTML 块', () => {
    const c = on('<video>x</video>')
    expect(c.querySelector('.md-html')).toBeNull()
  })
})

describe('★ 内嵌 HTML —— 流式半截片段', () => {
  it('未闭合的片段显示占位,不渲染半截 DOM', () => {
    const c = on('前面的正文\n\n<div style="padd')
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.querySelector('.md-html-pending')).toBeTruthy()
    expect(c.textContent).toContain('前面的正文')
  })
  it('片段闭合的那一刻换成真卡片', () => {
    const c = on('<div style="padding:8px">写完了</div>')
    expect(c.querySelector('.md-html-pending')).toBeNull()
    expect(c.querySelector('.md-html')).toBeTruthy()
    expect(c.textContent).toBe('写完了')
  })
  it('跨多行的片段能正确合并', () => {
    const c = on('<div style="display:flex">\n  <span>左</span>\n  <span>右</span>\n</div>')
    expect(c.querySelector('.md-html')).toBeTruthy()
    expect(c.querySelectorAll('.md-html span')).toHaveLength(2)
  })
})

describe('★ 内嵌 HTML —— 攻击面(经由完整渲染路径)', () => {
  it('片段里的 script 不落地', () => {
    const c = on('<div>正文<script>window.forge.settingsSet({})</script></div>')
    expect(c.querySelector('script')).toBeNull()
    expect(c.innerHTML).not.toContain('forge')
  })
  it('片段里的事件属性不落地', () => {
    const c = on('<div onclick="window.forge.runStop()">点</div>')
    expect(c.innerHTML).not.toContain('onclick')
    expect(c.innerHTML).not.toContain('forge')
  })
  it('片段里的颜色全部换成 token,不含字面色值', () => {
    const c = on('<div style="background:#fff;color:#111;border:1px solid #ddd">卡片</div>')
    expect(c.innerHTML).not.toMatch(/#[0-9a-f]{3}/i)
    expect(c.innerHTML).toContain('var(--')
  })
})

describe('★ 未闭合片段不吞内容', () => {
  it('模型忘了写闭合标签时,原文仍可展开查看 —— 内容任何情况下都不会丢', () => {
    const c = on('<div style="padding:8px">忘了闭合的卡片\n\n后面还有一段正文')
    const det = c.querySelector('details.md-html-pending')
    expect(det).toBeTruthy()
    expect(det?.querySelector('summary')?.textContent).toBe('可视化生成中…')
    expect(det?.querySelector('pre')?.textContent).toContain('忘了闭合的卡片')
    expect(det?.querySelector('pre')?.textContent).toContain('后面还有一段正文')
  })
})

// ★ 「让 claude 读代码」时,回复里引用的代码绝不能被当成内嵌可视化片段。
//
// 真实故障:一轮读代码的回复永久停在「可视化生成中…」,整条回复剩下的内容全被吞进那个折叠块。
// 根因是这里的分支顺序 —— 内嵌 HTML 块分支跑在代码围栏分支【之前】,而且两道门都太松:
//   1) 围栏正则只认 ```lang 这种「纯一个词」的信息串,```tsx title="A.tsx" / ```tsx:src/a.tsx 都不认,
//      于是围栏没被识别,里面第一行 <div …> 直接掉进 HTML 分支;
//   2) HTML 开标签正则允许任意前导空白,于是四空格缩进的代码摘录也被当成片段。
// 而代码摘录本来就极少配平,进了 HTML 分支就永远等不到闭合标签 → 吃光后文、永久「生成中」。
describe('★ 代码引用不能被误当成可视化片段(读代码场景)', () => {
  const pending = (c: HTMLElement) => c.querySelectorAll('details.md-html-pending')

  it('围栏带额外信息串(```tsx title="…")仍是代码块,不是 HTML', () => {
    const c = on('这段在 ReqCard.tsx：\n\n```tsx title="ReqCard.tsx"\n<div className="req-opts">\n  {action.options.map((o, i) => (\n```\n\n后面还有解释正文。')
    expect(pending(c)).toHaveLength(0)
    expect(c.querySelector('.md-html')).toBeNull()          // 绝不能渲染成活的卡片
    expect(c.textContent).toContain('后面还有解释正文。')   // 后文不能被吞
    expect(c.querySelector('pre')?.textContent).toContain('req-opts')
  })

  it('围栏写成 ```tsx:src/x.tsx 也仍是代码块', () => {
    const c = on('看：\n\n```tsx:src/renderer/x.tsx\n<div className="a">\n  <span>x\n```\n\n后面还有正文。')
    expect(pending(c)).toHaveLength(0)
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.textContent).toContain('后面还有正文。')
  })

  it('四空格缩进的代码摘录不进 HTML 分支(4 空格起是 Markdown 的缩进代码,不是 HTML 块)', () => {
    const c = on('这段在 ReqCard.tsx：\n\n    <div className="req-opts">\n      {action.options.map((o, i) => (\n\n后面还有解释正文。')
    expect(pending(c)).toHaveLength(0)
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.textContent).toContain('后面还有解释正文。')
  })

  it('列表项里缩进的 JSX 摘录不吞掉后面的列表项', () => {
    const c = on('- 第一处 `ReqCard.tsx`：\n\n    <div className="req-opt">\n\n- 第二处 `Message.tsx`')
    expect(pending(c)).toHaveLength(0)
    expect(c.textContent).toContain('第二处')
  })

  it('回归护栏:模型真正的片段(顶格 + 内联 style)照旧渲染', () => {
    // 指令里明令禁止 class、要求 100% 内联 style —— 真片段就是顶格这一种形态。
    const c = on('<div style="display:flex">卡片</div>')
    expect(c.querySelector('.md-html')).toBeTruthy()
    expect(pending(c)).toHaveLength(0)
  })

  it('回归护栏:CommonMark 允许片段有 1–3 个前导空格,这仍算片段', () => {
    const c = on('  <div style="display:flex">卡片</div>')
    expect(c.querySelector('.md-html')).toBeTruthy()
  })
})
