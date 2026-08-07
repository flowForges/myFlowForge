import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { renderHtmlFragment, isFragmentClosed, newFragmentScan, feedFragment } from './htmlFragment'

const html = (src: string): string => {
  const { container } = render(<div>{renderHtmlFragment(src)}</div>)
  return container.innerHTML
}
const dom = (src: string): HTMLElement => render(<div>{renderHtmlFragment(src)}</div>).container

describe('renderHtmlFragment —— 正常片段', () => {
  it('重建白名单内的结构标签', () => {
    const out = html('<div style="display:flex;gap:8px"><span>左</span><span>右</span></div>')
    expect(out).toContain('<div style="display: flex; gap: 8px;">')
    expect(out).toContain('<span>左</span>')
    expect(out).toContain('<span>右</span>')
  })
  it('保留纯文本与嵌套', () => {
    expect(dom('<div><strong>标题</strong>：正文</div>').textContent).toBe('标题：正文')
  })
  it('自闭合标签不带 children', () => {
    expect(html('<div>一<br>二<hr></div>')).toContain('<br>')
  })
  it('details/summary 折叠可用', () => {
    const out = html('<details><summary>展开</summary><div>内容</div></details>')
    expect(out).toContain('<details>')
    expect(out).toContain('<summary>展开</summary>')
  })
  it('未知标签拆掉外壳但保留内容 —— 内容不该因为一个没见过的容器就消失', () => {
    expect(dom('<article><div>正文还在</div></article>').textContent).toBe('正文还在')
    expect(html('<article><div>正文还在</div></article>')).not.toContain('<article>')
  })
  it('畸形/空输入不炸', () => {
    expect(() => html('')).not.toThrow()
    expect(() => html('<div><span></div>')).not.toThrow()
    expect(() => html('<<<>>>')).not.toThrow()
  })
})

describe('★ renderHtmlFragment —— 攻击样本', () => {
  // 每条都做过变异验证:把 htmlFragment.tsx 里对应的白名单条目删掉/放宽,对应用例必须变红。
  it('<script> 连同子树整个丢弃(大小写/空白变体一样)', () => {
    for (const src of [
      '<div>前<script>window.forge.settingsSet({})</script>后</div>',
      '<div><SCRIPT>alert(1)</SCRIPT></div>',
      '<div><script\n type="text/javascript">alert(1)</script></div>',
    ]) {
      const c = dom(src)
      expect(c.querySelector('script')).toBeNull()
      expect(c.textContent).not.toContain('alert')
      expect(c.textContent).not.toContain('forge')
    }
  })

  it('事件属性一律不构造 —— 这是 window.forge 全部 IPC 的入口', () => {
    const c = dom('<div onclick="window.forge.settingsSet({})" onmouseover="fetch(1)" onerror="x()">点我</div>')
    const el = c.querySelector('div div') ?? c.querySelector('div')!
    expect(el.getAttribute('onclick')).toBeNull()
    expect(el.getAttribute('onmouseover')).toBeNull()
    expect(el.getAttribute('onerror')).toBeNull()
    expect(c.innerHTML).not.toContain('forge')
  })

  it('事件属性不会变成 React 的真事件处理器(点击不触发任何东西)', () => {
    const spy = vi.fn()
    ;(window as unknown as Record<string, unknown>)['__pwned'] = spy
    const c = dom('<div onclick="window.__pwned()">点我</div>')
    fireEvent.click(c.querySelector('div div') ?? c.querySelector('div')!)
    expect(spy).not.toHaveBeenCalled()
  })

  it('<img> 不构造 —— 远程 src 是追踪信标 + 泄露出口 IP', () => {
    const c = dom('<div><img src="http://evil.example/beacon.png" onerror="alert(1)"></div>')
    expect(c.querySelector('img')).toBeNull()
  })

  it('<a href> 不构造 —— javascript: 面', () => {
    const c = dom('<div><a href="javascript:alert(1)">点</a></div>')
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toBe('点')      // 文字保留,只是不再是链接
  })

  it('<iframe>/<object>/<form>/<textarea>/<button>/<select> 连同子树丢弃', () => {
    for (const t of ['iframe', 'object', 'form', 'textarea', 'button', 'select']) {
      const c = dom(`<div><${t}>子树标记</${t}></div>`)
      expect(c.querySelector(t)).toBeNull()
      // 连内容一起没 —— 只断言「元素不在」的话,这条测试对 DROP_SUBTREE 是不敏感的(未知标签的
      // 「拆壳保留子节点」也会让元素消失),等于白名单少了一层覆盖。
      expect(c.textContent).not.toContain('子树标记')
    }
  })

  it('<input>/<embed> 这类空元素本身不构造', () => {
    // 空元素在 HTML 规范里不能有子节点,浏览器解析时会把后面的文字变成它的**兄弟**节点 —— 所以这里
    // 只断言元素不存在,不断言文本消失(那段文字本来就不属于它)。
    for (const t of ['input', 'embed', 'source', 'track']) {
      const c = dom(`<div><${t}>x</${t}></div>`)
      expect(c.querySelector(t)).toBeNull()
    }
  })

  it('<style> 连同子树丢弃 —— 否则等于放开全局 CSS', () => {
    const c = dom('<div><style>body{display:none}</style>正文</div>')
    expect(c.querySelector('style')).toBeNull()
    expect(c.textContent).toBe('正文')
  })

  it('position:fixed + z-index 盖屏被剥掉,元素本身还在', () => {
    const c = dom('<div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999">盖屏</div>')
    const el = (c.querySelector('div div') ?? c.querySelector('div')!) as HTMLElement
    expect(el.style.position).toBe('')
    expect(el.style.zIndex).toBe('')
    expect(c.textContent).toBe('盖屏')
  })

  it('class / id 不构造 —— 否则能顶掉应用自己的样式', () => {
    const c = dom('<div class="msg-body" id="root">x</div>')
    const el = c.querySelector('div div') ?? c.querySelector('div')!
    expect(el.getAttribute('class')).toBeNull()
    expect(el.getAttribute('id')).toBeNull()
  })

  it('输出的 style 里永远不含字面色值(配色一律走 token)', () => {
    const out = html('<div style="background:#fff;color:#111;border:1px solid #ddd">卡片</div>')
    expect(out).not.toMatch(/#[0-9a-f]{3}/i)
    expect(out).not.toMatch(/rgba?\(/i)
    expect(out).toContain('var(--')
  })

  it('嵌套过深时停止,不爆栈', () => {
    const deep = '<div>'.repeat(200) + '底' + '</div>'.repeat(200)
    expect(() => html(deep)).not.toThrow()
  })
})

describe('提升 —— HTML 里的 table/pre 接到既有组件上', () => {
  it('朴素表格提升成 TableBlock(于是能排序能复制)', () => {
    const c = dom('<table><tr><th>城市</th><th>人口</th></tr><tr><td>北京</td><td>2189</td></tr><tr><td>上海</td><td>2487</td></tr></table>')
    expect(c.querySelector('.table-block')).toBeTruthy()
    expect(c.querySelector('.tbl-copy')).toBeTruthy()
    expect(c.querySelectorAll('.tbl-sort')).toHaveLength(2)
    fireEvent.click(c.querySelectorAll('.tbl-sort')[1] as HTMLElement)
    const first = c.querySelectorAll('tbody tr')[0].querySelectorAll('td')
    expect(first[0].textContent).toBe('北京')      // 2189 < 2487
  })

  it('带 colspan 的表格不提升,回退成普通表格(优雅降级)', () => {
    const c = dom('<table><tr><th colspan="2">合并</th></tr><tr><td>a</td><td>b</td></tr></table>')
    expect(c.querySelector('.table-block')).toBeNull()
    expect(c.querySelector('table')).toBeTruthy()
    expect(c.querySelector('th')?.getAttribute('colspan')).toBe('2')
  })

  it('列数不齐的表格不提升', () => {
    const c = dom('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr></table>')
    expect(c.querySelector('.table-block')).toBeNull()
    expect(c.querySelector('table')).toBeTruthy()
  })

  it('<pre> 提升成 CodeBlock(于是能折叠能复制)', () => {
    const c = dom('<pre>npm run build</pre>')
    expect(c.querySelector('.code-block')).toBeTruthy()
    expect(c.querySelector('.cb-copy')).toBeTruthy()
    expect(c.querySelector('.cb-fold')).toBeTruthy()
    expect(c.querySelector('pre > code')?.textContent).toBe('npm run build')
  })

  it('空 <pre> 不提升成空代码块', () => {
    const c = dom('<pre>   </pre>')
    expect(c.querySelector('.code-block')).toBeNull()
  })
})

describe('isFragmentClosed —— 流式半截片段', () => {
  it('闭合的片段判为 true', () => {
    expect(isFragmentClosed('<div>x</div>')).toBe(true)
    expect(isFragmentClosed('<div><span>a</span><span>b</span></div>')).toBe(true)
    expect(isFragmentClosed('<div>一<br>二</div>')).toBe(true)          // 自闭合不入栈
    expect(isFragmentClosed('<div/>')).toBe(true)
  })
  it('半截片段判为 false —— 这些正是流式过程中每一帧的样子', () => {
    expect(isFragmentClosed('<div style="padd')).toBe(false)
    expect(isFragmentClosed('<div><span>a</span>')).toBe(false)
    expect(isFragmentClosed('<div><table><tr><td>x')).toBe(false)
  })
  it('闭标签没有对应开标签判为 false', () => {
    expect(isFragmentClosed('</div>')).toBe(false)
  })
  it('★ 增量喂入与一次性判定结果一致(块级识别逐行喂,不能两条路走出不同答案)', () => {
    const cases = [
      ['<div style="display:flex">', '  <span>左</span>', '  <span>右</span>', '</div>'],
      ['<div>', '<table><tr><td>x</td></tr></table>', '</div>'],
      ['<details>', '<summary>标题</summary>', '<div>内容</div>'],          // 未闭合
      ['<div style="padd'],                                                  // 半截标签
    ]
    for (const lines of cases) {
      const scan = newFragmentScan()
      let incremental = false
      lines.forEach((ln, idx) => { incremental = feedFragment(scan, (idx ? '\n' : '') + ln) })
      expect(incremental).toBe(isFragmentClosed(lines.join('\n')))
    }
  })
  it('增量扫描的残余缓冲不随片段增长(否则等于又变回整段重扫)', () => {
    const scan = newFragmentScan()
    for (let n = 0; n < 200; n++) feedFragment(scan, `<div style="padding:4px">第 ${n} 行的一些正文内容</div>\n`)
    expect(scan.pending.length).toBeLessThan(80)
  })
})
