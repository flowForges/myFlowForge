import { describe, it, expect } from 'vitest'
import { HTML_MAX_DEPTH, HTML_MAX_LEN, decodeEntities, parseHtmlSubset, type HNode } from './htmlParse'

/**
 * 这份测试守的是**两件事**,它们方向相反、都必须成立:
 *  ① 能画的要真画出来(不然功能等于没做);
 *  ② 画不忠实的要**整段退回**折叠占位 —— 而且危险的东西(script / on* / javascript:)
 *     在任何情况下都不能出现在输出树里。
 * ②比①重要:画错了人还以为自己看的是全部。
 */

/** 把树拍平成文本,方便断言「这段内容还在不在」。 */
function flat(nodes: HNode[]): string {
  return nodes.map((n) => (n.t === 'text' ? n.text : flat(n.kids))).join('')
}
/** 树里出现过的所有标签名。 */
function tags(nodes: HNode[]): string[] {
  return nodes.flatMap((n) => (n.t === 'text' ? [] : [n.tag, ...tags(n.kids)]))
}
function ok(src: string) {
  const r = parseHtmlSubset(src)
  if (!r.ok) throw new Error(`本该能画,却退回了:${r.reason}`)
  return r.nodes
}
function reason(src: string): string {
  const r = parseHtmlSubset(src)
  if (r.ok) throw new Error(`本该退回折叠占位,却画了出来:${JSON.stringify(r.nodes)}`)
  return r.reason
}

describe('parseHtmlSubset · 能画的', () => {
  it('段落 + 加粗 + 斜体', () => {
    const n = ok('<p>hello <strong>bold</strong> and <em>it</em></p>')
    expect(tags(n)).toEqual(['p', 'strong', 'em'])
    expect(flat(n)).toBe('hello bold and it')
  })

  it('无序 / 有序列表', () => {
    const n = ok('<ul><li>a</li><li>b</li></ul>')
    expect(tags(n)).toEqual(['ul', 'li', 'li'])
    expect(flat(n)).toBe('ab')
    expect(tags(ok('<ol><li>x</li></ol>'))).toEqual(['ol', 'li'])
  })

  it('标题', () => {
    expect(tags(ok('<h2>标题</h2>'))).toEqual(['h2'])
    expect(tags(ok('<h6>小</h6>'))).toEqual(['h6'])
  })

  it('表格(含表头)', () => {
    const n = ok('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
    expect(tags(n)).toEqual(['table', 'thead', 'tr', 'th', 'th', 'tbody', 'tr', 'td', 'td'])
    expect(flat(n)).toBe('AB12')
  })

  it('行内代码和代码块', () => {
    expect(tags(ok('<p>用 <code>npm i</code> 装</p>'))).toEqual(['p', 'code'])
    expect(tags(ok('<pre>line1\nline2</pre>'))).toEqual(['pre'])
  })

  it('★<pre> 里的空白原样保留,别的地方折叠', () => {
    // 折了的话缩进就没了,一段贴进来的代码会变成一行没有结构的字。
    expect(flat(ok('<pre>a\n  b</pre>'))).toBe('a\n  b')
    // 反过来:普通段落里源码的换行 + 缩进不折的话,句子中间会多出一大串空格。
    expect(flat(ok('<p>a\n   b</p>'))).toBe('a b')
  })

  it('链接:http / https / mailto 放行,href 带出来', () => {
    const n = ok('<p><a href="https://example.com/x">去看看</a></p>')
    const a = (n[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>
    expect(a.tag).toBe('a')
    expect(a.href).toBe('https://example.com/x')
    expect(reason('<a href="/local">x</a>')).toBe('unsafe-href')
  })

  it('br / hr 是自闭合,不入栈', () => {
    expect(tags(ok('<p>a<br>b</p>'))).toEqual(['p', 'br'])
    expect(tags(ok('<p>a<br/>b</p>'))).toEqual(['p', 'br'])
    expect(tags(ok('<div>x<hr />y</div>'))).toEqual(['div', 'hr'])
  })

  it('★不带引号的属性也要认(模型常这么写)', () => {
    const n = ok('<table><tr><td colspan=2>x</td></tr></table>')
    const td = ((n[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>
    expect(td.colSpan).toBe(2)
    // 单引号同理
    const n2 = ok("<table><tr><td rowspan='3'>x</td></tr></table>")
    const td2 = ((n2[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>
    expect(td2.rowSpan).toBe(3)
  })

  it("★不带引号的 href 末尾那个斜杠不能被当成自闭合砍掉", () => {
    const n = ok('<p><a href=https://example.com/>x</a></p>')
    const a = (n[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>
    expect(a.href).toBe('https://example.com/')
  })

  it('标签名大小写不敏感', () => {
    expect(tags(ok('<DIV><P>x</P></DIV>'))).toEqual(['div', 'p'])
  })

  it('注释整段跳过,不留痕', () => {
    expect(flat(ok('<p>a<!-- 注释 -->b</p>'))).toBe('ab')
  })

  it('★`a < b` 里的 < 是普通字符,不是标签', () => {
    expect(flat(ok('<p>a < b</p>'))).toBe('a < b')
  })

  it('★闭合时攒着的文本落在自己身上,不落到父亲身上', () => {
    // 落错了的话 `<li>a</li><li>b</li>` 会画成一个空列表 + 两段游离的文字。
    const ul = ok('<ul><li>a</li><li>b</li></ul>')[0] as Extract<HNode, { t: 'el' }>
    expect(ul.kids.map((k) => (k.t === 'el' ? flat(k.kids) : '?'))).toEqual(['a', 'b'])
  })
})

describe('decodeEntities', () => {
  it('命名实体', () => {
    expect(decodeEntities('a &amp;&amp; b')).toBe('a && b')
    expect(decodeEntities('&lt;div&gt;')).toBe('<div>')
    expect(decodeEntities('&quot;x&quot;')).toBe('"x"')
  })

  it('数字实体(十进制 / 十六进制)', () => {
    expect(decodeEntities('&#39;')).toBe("'")
    expect(decodeEntities('&#x27;')).toBe("'")
    expect(decodeEntities('&#8230;')).toBe('…')
  })

  it('认不出的原样留着,不吞字', () => {
    expect(decodeEntities('&nosuch; &amp')).toBe('&nosuch; &amp')
  })

  it('★控制字符不生成 —— 造个 U+0000 出来只会画成豆腐块', () => {
    expect(decodeEntities('&#0;')).toBe('&#0;')
  })

  it('★正文里的实体在解析后被解码', () => {
    expect(flat(ok('<p>a &amp;&amp; b</p>'))).toBe('a && b')
  })

  it('★★先解析后解码 —— `&lt;script&gt;` 只能是四个字,不能变成一个真标签', () => {
    const n = ok('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(tags(n)).toEqual(['p'])
    expect(flat(n)).toBe('<script>alert(1)</script>')
  })
})

describe('parseHtmlSubset · 必须整段退回的', () => {
  it('★★<script> 永远进不了输出树', () => {
    expect(reason('<div><script>alert(1)</script></div>')).toBe('unknown-tag:script')
    expect(reason('<script src="https://evil/x.js"></script>')).toBe('unknown-tag:script')
    // 大小写混写也一样
    expect(reason('<div><ScRiPt>x</ScRiPt></div>')).toBe('unknown-tag:script')
  })

  it('★★on* 事件属性永远进不了输出树', () => {
    expect(reason('<div onclick="steal()">x</div>')).toBe('event-attr:onclick')
    expect(reason('<p ONLOAD=x>y</p>')).toBe('event-attr:onload')
    expect(reason('<a href="https://a.com" onmouseover="x">y</a>')).toBe('event-attr:onmouseover')
  })

  it('★javascript: / data: 的 href 退回', () => {
    expect(reason('<a href="javascript:alert(1)">x</a>')).toBe('unsafe-href')
    expect(reason('<a href="data:text/html,<b>x">y</a>')).toBe('unsafe-href')
  })

  it('★任意 CSS(style=)退回 —— 那段样式往往就是片段的全部意思', () => {
    expect(reason('<div style="display:flex;gap:8px">x</div>')).toBe('attr:div.style')
    expect(reason('<span class="badge">x</span>')).toBe('attr:span.class')
  })

  it('未知标签退回', () => {
    expect(reason('<iframe src="https://x"></iframe>')).toBe('unknown-tag:iframe')
    expect(reason('<svg><circle/></svg>')).toBe('unknown-tag:svg')
    expect(reason('<div><img src="https://tracker/p.gif"></div>')).toBe('unknown-tag:img')
    expect(reason('<form><input></form>')).toBe('unknown-tag:form')
    expect(reason('<style>body{}</style>')).toBe('unknown-tag:style')
  })

  it('★没闭合的标签退回(流式吐到一半的片段就是这样)', () => {
    expect(reason('<div><p>half')).toBe('unclosed-tag')
    expect(reason('<table><tr><td>1')).toBe('unclosed-tag')
  })

  it('★闭标签对不上开标签退回 —— 猜错就是把后面半段吞掉', () => {
    expect(reason('<div><p>x</div></p>')).toBe('mismatched-close')
    expect(reason('<p>x</span>')).toBe('mismatched-close')
  })

  it('没闭合的注释退回', () => {
    expect(reason('<p>a<!-- 没写完')).toBe('unclosed-comment')
  })

  it('doctype / 处理指令退回(那不是「一小段片段」)', () => {
    expect(reason('<!DOCTYPE html><p>x</p>')).toBe('unsupported-directive')
  })

  it(`★嵌套超过 ${HTML_MAX_DEPTH} 层退回`, () => {
    const deep = (d: number) => '<div>'.repeat(d) + 'x' + '</div>'.repeat(d)
    expect(parseHtmlSubset(deep(HTML_MAX_DEPTH)).ok).toBe(true)
    expect(reason(deep(HTML_MAX_DEPTH + 1))).toBe('too-deep')
    // ★★上面两行**只用常量表达**,所以把常量本身改成 100 它们照样全绿(变异测试当场抓到的假绿)。
    //  两条闸都必须再钉一个**写死的数**:一个是常量的值,一个是这个值下的真实行为。
    expect(HTML_MAX_DEPTH).toBe(8)
    expect(reason(deep(20))).toBe('too-deep')
  })

  it('★整段太长退回 —— 几十 KB 的表格在手机上就是几秒白屏', () => {
    expect(reason('<p>' + 'x'.repeat(HTML_MAX_LEN) + '</p>')).toBe('too-long')
    expect(HTML_MAX_LEN).toBe(20_000)
    expect(reason('<p>' + 'x'.repeat(60_000) + '</p>')).toBe('too-long')
  })

  it('colspan 不是正整数就退回', () => {
    expect(reason('<table><tr><td colspan="abc">x</td></tr></table>')).toBe('span:colspan')
    expect(reason('<table><tr><td colspan="0">x</td></tr></table>')).toBe('span:colspan')
    expect(reason('<table><tr><td colspan="999">x</td></tr></table>')).toBe('span:colspan')
  })

  it('<a> 没有 href 退回(我们不该画一个点不开的链接)', () => {
    expect(reason('<p><a>x</a></p>')).toBe('a-without-href')
  })

  it('空片段退回', () => {
    expect(reason('')).toBe('empty')
    expect(reason('   \n  ')).toBe('empty')
  })
})
