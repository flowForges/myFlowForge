import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './markdown'

// 用户报的症状:「偶尔输出的内容解析失败,表格出现了折叠,里面的 markdown 表格解析失败了」。
// 折叠 = CodeBlock 的折叠条。也就是说表格连同后文被一个围栏吞进了代码块。
// 下面每条都是模型真会写出来的形态,复现路径见 debug 记录。
const md = (text: string) => render(<Markdown text={text} />).container
const TABLE = ['| 阶段 | 状态 |', '|---|---|', '| 设计 | 完成 |'].join('\n')
/** 表格源码是不是被塞进了代码块(而不是渲染成 <table>) */
const eaten = (c: HTMLElement) =>
  [...c.querySelectorAll('.code-block pre')].some(p => (p.textContent ?? '').includes('|---|'))

describe('围栏长度按 CommonMark 算(反引号数量)', () => {
  it('四反引号开的围栏:里面的 ``` 是内容,不是闭合', () => {
    const c = md(['````markdown', '# 标题', '```bash', 'npm i', '```', '````', '', TABLE].join('\n'))
    expect(c.querySelectorAll('.code-block')).toHaveLength(1)
    expect(c.querySelector('.code-block pre')?.textContent).toContain('```bash')
    // 围栏本身不该以正文形式漏出来
    expect(c.textContent).not.toContain('````')
    expect(c.querySelector('table')).toBeInTheDocument()
  })

  it('三反引号开、四反引号闭:仍然算闭合,后面的表格照常解析', () => {
    const c = md(['```ts', 'const a = 1', '````', '', TABLE].join('\n'))
    expect(eaten(c)).toBe(false)
    expect(c.querySelector('table')).toBeInTheDocument()
  })

  it('闭合围栏比开围栏短:不算闭合(``` 开不能被 `` 收)', () => {
    const c = md(['````', 'x', '```', 'y', '````'].join('\n'))
    expect(c.querySelectorAll('.code-block')).toHaveLength(1)
    expect(c.querySelector('.code-block pre')?.textContent).toContain('```')
  })
})

describe('没闭合的围栏不该把表格吞掉', () => {
  it('模型忘了收尾围栏:代码留在代码块里,表格仍然是表格', () => {
    const c = md(['看代码:', '', '```ts', 'const a = 1', '', TABLE, '', '以上。'].join('\n'))
    expect(eaten(c)).toBe(false)
    expect(c.querySelector('table')).toBeInTheDocument()
    expect(c.querySelector('.code-block pre')?.textContent).toContain('const a = 1')
    expect(c.textContent).toContain('以上。')
  })

  it('正文里孤立一行 ```(模型在解释围栏语法)', () => {
    const c = md(['单独一行这样写:', '', '```', '', '然后写表格:', '', TABLE].join('\n'))
    expect(eaten(c)).toBe(false)
    expect(c.querySelector('table')).toBeInTheDocument()
  })

  it('嵌套演示导致的围栏错位', () => {
    const c = md(['你可以这样写:', '', '```markdown', '## 用法', '```bash', 'npm i', '```', '```', '', TABLE].join('\n'))
    expect(eaten(c)).toBe(false)
    expect(c.querySelector('table')).toBeInTheDocument()
  })

  it('真被截断的代码(里面没有表格)保持原样进代码块 —— 不误伤', () => {
    const c = md(['```ts', 'function f() {', '  const pipe = "a | b"', '  // 注释 # 井号'].join('\n'))
    expect(c.querySelectorAll('.code-block')).toHaveLength(1)
    expect(c.querySelector('.code-block pre')?.textContent).toContain('const pipe')
    expect(c.querySelector('table')).toBeNull()
  })

  it('已闭合的围栏里含表格源码(引用文档)不受影响,仍然是代码', () => {
    const c = md(['````markdown', TABLE, '````', '', '正文', '', TABLE].join('\n'))
    expect(c.querySelectorAll('table')).toHaveLength(1)
    expect(eaten(c)).toBe(true)
  })
})
