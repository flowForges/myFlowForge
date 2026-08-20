import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './markdown'

// 内嵌 HTML 与 Markdown 的两条接缝(2026-08-20 真机报障)。
//
// ① 模型用 GitHub 那套惯用法把长文档折起来:<details><summary>标题（点开）</summary> + 空行 + ```markdown …
//    原来块级 HTML 分支会一路吃到片段闭合,中间的围栏被降级成 HTML 里的纯文本 —— 点开是有的,但里面既没有
//    代码块也没有高亮,而且因为成了 HTML,浏览器把换行**折叠掉**,整段 SQL 挤成一行。
//    CommonMark 的规矩是「空行结束 HTML 块,之后重新按 Markdown 解析」,GitHub 就是这么渲染的,模型也正是
//    冲着这条规矩才写的空行。
//
// ② 块级标签开在【行中】(「…结论。<div style=…>」把卡片紧跟在句子后面)。块级识别只认行首,而行内 HTML 的
//    白名单又刻意不含块级标签 —— 两边都不接,标签原样漏成文本。

const on = (text: string): HTMLElement => render(<Markdown text={text} allowHtml />).container

describe('容器里的 Markdown(空行结束 HTML 块)', () => {
  const DETAILS_MD = [
    '<details>',
    '<summary>黄金 SQL 文档模板（点开）</summary>',
    '',
    '```markdown',
    '# 招商域 · 黄金 SQL 样例',
    'SELECT ds FROM t WHERE ds = 1;',
    '```',
    '',
    '</details>',
  ].join('\n')

  it('★ details 里的 ```markdown 围栏要渲染成代码块,不是一坨纯文本', () => {
    const c = on(DETAILS_MD)
    expect(c.querySelector('details')).toBeTruthy()          // 折叠块本身还在
    expect(c.querySelector('details pre')).toBeTruthy()      // ★ 里面是真代码块
    expect(c.textContent).not.toContain('```')               // 反引号不该漏到正文里
  })

  it('★ 换行必须保住 —— 成了 HTML 就会被浏览器折叠,整段 SQL 挤成一行(这正是用户看到的样子)', () => {
    const pre = on(DETAILS_MD).querySelector('details pre')
    expect(pre?.textContent).toContain('# 招商域 · 黄金 SQL 样例\nSELECT ds FROM t WHERE ds = 1;')
  })

  it('★ json 同样(用户说 markdown 或 json 都出现过)', () => {
    const c = on(['<details>', '<summary>配置（点开）</summary>', '', '```json', '{"a": 1}', '```', '', '</details>'].join('\n'))
    expect(c.querySelector('details pre')?.textContent).toContain('{"a": 1}')
  })

  it('summary 仍然是 summary,不能被当成 Markdown 正文冲掉', () => {
    const c = on(DETAILS_MD)
    expect(c.querySelector('details summary')?.textContent).toContain('黄金 SQL 文档模板（点开）')
  })

  it('div 容器里的表格也照样渲染(不只 details 一种)', () => {
    const c = on(['<div style="padding:8px">', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '</div>'].join('\n'))
    expect(c.querySelector('table')).toBeTruthy()
  })

  it('★ 没有空行的容器不受影响 —— 那是纯粹的 HTML 卡片,不该被重新当 Markdown 解析', () => {
    const c = on('<div style="border:1px solid #090;padding:10px">\n✅ 虚惊一场：Validate() 只在 handler 里调用。\n</div>')
    expect(c.querySelector('.md-html')).toBeTruthy()
    expect(c.querySelector('p')).toBeNull()                  // 没被拆成段落
    expect(c.textContent).toContain('✅ 虚惊一场')
  })
})

describe('块级标签开在行中', () => {
  const MID = [
    '跑测试并复扫。关键检查：service 里有没有调 Validate()？<div style="border:1px solid #090;padding:10px">',
    '✅ 虚惊一场：只在 handler 里调用。',
    '</div>',
  ].join('\n')

  it('★ 标签不许原样漏成文本', () => {
    const c = on(MID)
    expect(c.textContent).not.toContain('<div')
    expect(c.textContent).not.toContain('</div>')
  })

  it('★ 前半句照常当段落,后面的卡片正常渲染', () => {
    const c = on(MID)
    expect(c.querySelector('p')?.textContent).toContain('跑测试并复扫。')
    expect(c.querySelector('.md-html')).toBeTruthy()
    expect(c.querySelector('.md-html')?.textContent).toContain('✅ 虚惊一场')
  })

  it('★★ 行内代码里的标签不许被当真 —— 「用 `<div>` 包一下」是在讲代码,不是要画卡片', () => {
    const c = on('用 `<div style="x">` 包一下')
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.querySelector('code')?.textContent).toBe('<div style="x">')
  })

  it('围栏内部的块级标签不受影响(围栏分支先把整段吃掉)', () => {
    const c = on(['```html', '<div>不要渲染我</div>', '```'].join('\n'))
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.querySelector('pre')?.textContent).toContain('<div>不要渲染我</div>')
  })
})

describe('Markdown 回灌的边界', () => {
  it('★ <p> 里不回灌 —— 段落里再塞 <p>/<pre> 是非法嵌套,浏览器会把外层 p 提前闭掉,版式当场散架', () => {
    const c = on('<p>前言\n\n```js\nx\n```\n</p>')
    expect(c.querySelector('p p')).toBeNull()
    expect(c.querySelector('p pre')).toBeNull()
  })

  it('★ summary 里不回灌(它只是个标题行)', () => {
    const c = on('<details>\n<summary>标题\n\n# 不该变成 h1\n</summary>\n</details>')
    expect(c.querySelector('summary h1')).toBeNull()
  })
})

describe('行中切分的两道守卫', () => {
  it('★★ 标签不在行尾就不切 —— 切了会把标签【后面的正文整段吞掉】', () => {
    // 标签紧贴在句号后面(前面没空格,所以过得了 [^\s] 那一关),但后面还有正文 —— 这时候切,
    // lines[i] 会被整行替换成开标签,标签之后的内容当场消失。
    const c = on('结论。<div>里面</div>后面')
    expect(c.textContent).toContain('结论。')
    expect(c.textContent).toContain('后面')   // ← 去掉行尾锚点这里就没了
  })

  it('★ 行内代码没闭合时不切 —— 「包进 `<div style="x">」是在讲代码,只是反引号还没收', () => {
    const c = on('把它包进 `<div style="x">\n还没闭合的行内代码')
    // 未闭合片段走的是 .md-html-pending(那张「可视化生成中…」的折叠卡),不是 .md-html —— 查错类名
    // 会让这条守卫看着有覆盖、其实零覆盖。
    expect(c.querySelector('.md-html-pending')).toBeNull()
    expect(c.querySelector('.md-html')).toBeNull()
    expect(c.textContent).toContain('<div style="x">')
  })
})
