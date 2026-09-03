import { describe, it, expect } from 'vitest'
import { HTML_MAX_DEPTH, HTML_MAX_LEN, decodeEntities, htmlFallbackNote, parseHtmlSubset, type HNode } from './htmlParse'

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
    // ★相对地址 / 站内锚点:**降级成普通文字**,不再整段退回。链接点不开是装饰层面的损失,
    //  整段退回是一个字都不给。★但树里不许留下 `a` 节点 —— 画一个点不开的链接是骗人。
    const rel = ok('<a href="/local">x</a>')
    expect(flat(rel)).toBe('x')
    expect(tags(rel)).not.toContain('a')
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

describe('parseHtmlSubset · 装饰属性:丢掉,接着画', () => {
  /**
   * ★这条 policy 是**改过的**。第一版是「不认识的属性 ⇒ 整段退回」,拿真实片段一跑就发现
   *  代理写的 HTML 几乎每段都带 `style=` / `class=`,于是用户看到的还是「手机端不渲染」——
   *  而他的原话就是「html不渲染」,等于什么都没改。
   *  丢装饰 ≠ 画一半:标签全在白名单里,结构和每一个字都照画,丢的只有配色间距。
   */
  it('★带 style 的表格照画,结构和文字一个不少', () => {
    const n = ok('<table style="width:100%;border-collapse:collapse"><tr><th style="color:red">A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')
    expect(tags(n)).toEqual(['table', 'tr', 'th', 'th', 'tr', 'td', 'td'])
    expect(flat(n)).toBe('AB12')
  })

  it('★带 class 的列表照画', () => {
    const n = ok('<ul class="checks"><li class="done">a</li><li>b</li></ul>')
    expect(tags(n)).toEqual(['ul', 'li', 'li'])
    expect(flat(n)).toBe('ab')
  })

  it('★style 的 div 包着表格照画(代理最常写的形状)', () => {
    const n = ok('<div style="padding:12px;background:#111"><h3>对比</h3><table><tr><td>x</td></tr></table></div>')
    expect(tags(n)).toEqual(['div', 'h3', 'table', 'tr', 'td'])
    expect(flat(n)).toBe('对比x')
  })

  it('id / title / role / data-* / aria-* 都丢掉', () => {
    expect(flat(ok('<p id="a" title="t" role="note" data-x="1" aria-label="L">hi</p>'))).toBe('hi')
    expect(tags(ok('<div data-testid="k"><p>hi</p></div>'))).toEqual(['div', 'p'])
  })

  it('★装饰属性丢掉,但真属性照旧读出来', () => {
    const n = ok('<table class="t"><tr><td class="c" colspan="2">x</td></tr></table>')
    const td = ((n[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>
    expect(td.colSpan).toBe(2)
    const a = ok('<p><a class="lnk" href="https://e.com">go</a></p>')
    const el = (a[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>
    expect(el.href).toBe('https://e.com')
  })

  it('★★on* 丢掉照画,而且**永远进不了输出树** —— 白名单是构造性的,不是「信任没人去调」', () => {
    const n = ok('<div onclick="steal()"><p onmouseover="x()">hi</p></div>')
    expect(tags(n)).toEqual(['div', 'p'])
    expect(flat(n)).toBe('hi')
    // 整棵树序列化之后一个字符都不该带上事件处理器的名字或它的值。
    const json = JSON.stringify(n)
    expect(json).not.toContain('onclick')
    expect(json).not.toContain('onmouseover')
    expect(json).not.toContain('steal')
    expect(json).not.toContain('x()')
  })

  it('★on* 大小写混写、以及跟真属性同框时也一样', () => {
    const n = ok('<p><a href="https://a.com" ONERROR="bad()">y</a></p>')
    const el = (n[0] as Extract<HNode, { t: 'el' }>).kids[0] as Extract<HNode, { t: 'el' }>
    expect(el.href).toBe('https://a.com')
    expect(JSON.stringify(n)).not.toContain('bad')
  })

  it('★★`<img onerror=…>` 整个消失 —— 树里既没有 img 也没有那串 onerror', () => {
    // img 在 DROP_SUBTREE 里(远程 src = 追踪信标 + 出口 IP 泄露),所以连同属性一起没了。
    // ★这条不是「过滤掉了」:输出树里**没有任何字段**能承载 src 或事件处理器,构造不出来。
    const n = ok('<p>前<img src="x" onerror="steal()">后</p>')
    expect(tags(n)).not.toContain('img')
    expect(JSON.stringify(n)).not.toContain('onerror')
    expect(JSON.stringify(n)).not.toContain('steal')
    expect(flat(n)).toBe('前后')            // 正文一个字没丢
  })
})

describe('parseHtmlSubset · 纯 CSS 画出来的东西', () => {
  /**
   * ★丢掉 `style=` 之后多出来的**新失败面**:柱状图 / 色块图例这种东西的意思全在样式里,
   *  文字一个都没有。丢了样式再画 = 一叠没有尺寸的空 View,屏幕上什么都看不见 ——
   *  那正是「让人以为自己看到了全部」的那种谎。所以单独拦下来退回折叠占位(点开还有原文)。
   */
  it('★用 div 拼的柱状图退回,不画成一片空白', () => {
    expect(reason('<div style="width:200px"><div style="width:60%;background:#4a9"></div><div style="width:30%;background:#a94"></div></div>')).toBe('css-only')
  })

  it('★色块图例(div 里套 span,全无文字)退回', () => {
    expect(reason('<div><div><span class="dot"></span></div></div>')).toBe('css-only')
  })

  it('★★图表有标题、只有柱子没文字 —— 这条只有脚手架那一关拦得住', () => {
    // 整段是有文字的(标题),所以 `no-text` 那一关放行;拦下它的必须是 `scaffolding`。
    // 少了这条,把 `scaffolding` 整个删掉,上面两个用例仍然会被 `no-text` 兜住而全绿(假绿)。
    expect(reason('<div><h3>本月销量</h3><div><div style="width:60%"></div><div style="width:30%"></div></div></div>')).toBe('css-only')
  })

  it('整段一个字都渲染不出来的退回', () => {
    expect(reason('<p></p>')).toBe('no-text')
    expect(reason('<p>   </p>')).toBe('no-text')
  })

  it('★有文字的 div 照画 —— 别把正常卡片一起拦了', () => {
    expect(tags(ok('<div style="border:1px solid"><p>一句话</p></div>'))).toEqual(['div', 'p'])
    // 带标签的柱状图(每根柱子旁边有数字)是有意义的,照画。
    expect(tags(ok('<div><div>60%</div><div>30%</div></div>'))).toEqual(['div', 'div', 'div'])
  })

  it('★<div><hr></div> 不算脚手架 —— 分隔线是真会画出来的', () => {
    expect(tags(ok('<div><hr></div>'))).toEqual(['div', 'hr'])
  })

  it('★没有文字的表格 / 列表不拦 —— 只查 div,别的标签自带结构', () => {
    // 空表格至少还画得出格子、空列表还有圆点;而丢了样式的 div 是真的什么都不剩。
    // ★这两条**必须让别处有文字**,否则整段会先被 `no-text` 拦掉,判定范围那一关就测不到了
    //  (变异测试抓到的假绿:把判定从「只查 div」扩到「查所有标签」,原来那条用例照样全绿)。
    expect(tags(ok('<div><p>说明</p><table><tr><td></td></tr></table></div>'))).toEqual(['div', 'p', 'table', 'tr', 'td'])
    expect(tags(ok('<div><p>说明</p><ul><li></li></ul></div>'))).toEqual(['div', 'p', 'ul', 'li'])
  })

  it('★空的 div 挨着正文不算脚手架 —— 模型很爱吐 `<div style="clear:both"></div>` 这种垫片', () => {
    // ★同样是变异测试抓到的假绿:去掉「装着别的元素」这个前提之后,一个**叶子**空 div 就足以
    //  把整段正常内容一起拖去折叠占位。脚手架的形状是「套着一层元素却一个字都没有」,不是「空」。
    expect(tags(ok('<p>一句话</p><div style="clear:both"></div>'))).toEqual(['p', 'div'])
    expect(tags(ok('<div><p>一句话</p><div class="spacer"></div></div>'))).toEqual(['div', 'p', 'div'])
  })
})

describe('parseHtmlSubset · 必须整段退回的', () => {
  it('★★<script> 整棵子树丢掉 —— 内容一个字都不许漏进输出树', () => {
    // ★策略 2026-09-03 变了:原来是整段退回,现在是**整棵子树丢掉、其余照画**。
    //  安全性没有变松,反而更紧:以前只是「这一段不画」,现在是「脚本内容根本不进树」。
    const n = ok('<div><p>正文</p><script>alert(1)</script></div>')
    expect(flat(n)).toBe('正文')
    expect(JSON.stringify(n)).not.toContain('alert')
    expect(tags(n)).not.toContain('script')

    // 大小写混写、以及带 src 的外链脚本,都一样
    expect(flat(ok('<div>a<ScRiPt>steal()</ScRiPt>b</div>'))).toBe('ab')
    expect(JSON.stringify(ok('<div>x<script src="https://evil/x.js"></script></div>'))).not.toContain('evil')

    // ★★脚本里带 HTML 字符串:必须按**字面**跳过。当成 HTML 解析的话,那个 `<div>`
    //  会入栈且永不闭合 ⇒ 整段 unclosed-tag 退回(而正文其实是好的)。
    const tricky = ok('<div><p>正文</p><script>var s = "<div>" + x;</script></div>')
    expect(flat(tricky)).toBe('正文')
  })

  it('★★javascript: / data: 的链接降级成文字 —— href 绝不进树', () => {
    // 降级不是放松:危险的 href **仍然一个字都进不了输出树**,只是不再连累整段。
    const js = ok('<p><a href="javascript:alert(1)">点我</a></p>')
    expect(flat(js)).toBe('点我')
    expect(tags(js)).not.toContain('a')
    expect(JSON.stringify(js)).not.toContain('javascript')
    expect(JSON.stringify(js)).not.toContain('alert')

    const data = ok('<p><a href="data:text/html,x">y</a></p>')
    expect(tags(data)).not.toContain('a')
    expect(JSON.stringify(data)).not.toContain('data:')
  })

  it('★名单外的**非装饰**属性仍然退回 —— 那个标签在这段里干嘛我们读不懂', () => {
    expect(reason('<div href="https://x">y</div>')).toBe('attr:div.href')
    expect(reason('<p colspan="2">y</p>')).toBe('attr:p.colspan')
  })

  it('★危险标签整棵丢掉,而不是把整段拖下水', () => {
    // iframe / form / input / style / svg 全在 DROP_SUBTREE 里:它们的内容是代码或元数据,
    // 不是给人读的正文。★丢的是它们自己,周围的正文照画。
    for (const [src, gone] of [
      ['<p>甲<iframe src="https://x"></iframe>乙</p>', 'iframe'],
      ['<p>甲<form><input></form>乙</p>', 'form'],
      ['<p>甲<style>body{color:red}</style>乙</p>', 'style'],
      ['<p>甲<svg><circle/></svg>乙</p>', 'svg'],
      ['<p>甲<img src="https://tracker/p.gif">乙</p>', 'img'],
    ] as const) {
      const n = ok(src)
      expect(flat(n), src).toBe('甲乙')
      expect(tags(n), src).not.toContain(gone)
    }
    // ★★丢的是**整棵子树**,不是「拆掉外壳留下孩子」。表单/选择器里那些文字是界面零件,
    //  不是正文 —— 漏进正文里就是一堆没有上下文的碎词。(这条同时钉住 drop ≠ skip。)
    expect(flat(ok('<p>甲<form>提交表单<input></form>乙</p>'))).toBe('甲乙')
    expect(flat(ok('<p>甲<select><option>选项一</option></select>乙</p>'))).toBe('甲乙')
    expect(flat(ok('<p>甲<iframe>浏览器不支持</iframe>乙</p>'))).toBe('甲乙')

    // 整段只有一个危险标签 ⇒ 一个字都渲染不出来 ⇒ 照旧退回(这条没松)
    expect(reason('<svg><circle/></svg>')).toBe('empty')
    expect(JSON.stringify(ok('<p>x<img src="https://tracker/p.gif"></p>'))).not.toContain('tracker')
  })

  it('★★未知的**容器**标签:拆掉外壳,内容一个字不丢', () => {
    // 这是这次改动的核心。代理写的 HTML 里 <section>/<figure>/<article>/<custom-card>
    // 随处可见,原来一个没见过的外壳就能让整段内容消失。
    for (const src of [
      '<section><p>内容</p></section>',
      '<article><p>内容</p></article>',
      '<figure><p>内容</p></figure>',
      '<my-card><p>内容</p></my-card>',
      '<div><wrapper><span>内</span><span>容</span></wrapper></div>',
    ]) {
      expect(flat(ok(src)), src).toBe('内容')
    }
    // 一整份 HTML 文档也画得出来 —— 代理很爱吐这个
    const doc = ok('<!DOCTYPE html><html><head><title>T</title></head><body><p>正文</p></body></html>')
    expect(flat(doc)).toBe('正文')
    expect(JSON.stringify(doc)).not.toContain('T')      // <title> 是元数据,整棵丢掉
  })

  it('★块边界的标签映射到块级,不会挤成一行', () => {
    // <dt>/<dd>/<summary> 自己就是那个块边界 —— 一律拆掉的话「术语」和「解释」会连成一片。
    const dl = ok('<dl><dt>术语</dt><dd>解释</dd></dl>')
    expect(flat(dl)).toBe('术语解释')
    const t = tags(dl)
    expect(t).toContain('h5')     // dt
    expect(t).toContain('p')      // dd
    const det = ok('<details><summary>标题</summary><p>正文</p></details>')
    expect(tags(det)).toContain('h4')
    expect(flat(det)).toBe('标题正文')
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

  it('★doctype / 处理指令跳过就行,别为了开头一行把整段折起来', () => {
    expect(flat(ok('<!DOCTYPE html><p>x</p>'))).toBe('x')
    expect(flat(ok('<?xml version="1.0"?><p>x</p>'))).toBe('x')
    // 但没闭合的指令仍然退回 —— 后面到底是指令还是正文说不准
    expect(reason('<p>x</p><!DOCTYPE html')).toBe('unclosed-directive')
  })

  it(`★嵌套超过 ${HTML_MAX_DEPTH} 层退回`, () => {
    const deep = (d: number) => '<div>'.repeat(d) + 'x' + '</div>'.repeat(d)
    expect(parseHtmlSubset(deep(HTML_MAX_DEPTH)).ok).toBe(true)
    expect(reason(deep(HTML_MAX_DEPTH + 1))).toBe('too-deep')
    // ★★上面两行**只用常量表达**,所以把常量本身改成 100 它们照样全绿(变异测试当场抓到的假绿)。
    //  两条闸都必须再钉一个**写死的数**:一个是常量的值,一个是这个值下的真实行为。
    // ★2026-09-03 从 8 提到 24(和电脑端同一个数)。8 拦掉的是**正常表格**:
    //  table→tbody→tr→td→p→strong 已经 6 层,外面再包一层卡片就整段退回。
    expect(HTML_MAX_DEPTH).toBe(24)
    expect(reason(deep(40))).toBe('too-deep')
    // 一个包在卡片里的表格必须画得出来 —— 这是「8 太紧」的真实形状
    expect(parseHtmlSubset(
      '<div><div><table><tbody><tr><td><p><strong>x</strong></p></td></tr></tbody></table></div></div>',
    ).ok).toBe(true)
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

  it('<a> 没有 href:降级成文字 —— 不画点不开的链接,也不吞掉那几个字', () => {
    const n = ok('<p><a>x</a></p>')
    expect(flat(n)).toBe('x')
    expect(tags(n)).not.toContain('a')
  })

  it('空片段退回', () => {
    expect(reason('')).toBe('empty')
    expect(reason('   \n  ')).toBe('empty')
  })
})

describe('折叠占位那句话', () => {
  /**
   * ★★这条是为用户报的一个「诡异」现象加的:看的时候写着「手机端不渲染」,退出重进就画出来了。
   *  根因是代理还在流式吐字、标签没闭合,而那一刻占位条却说「手机端不渲染」—— **那是句假话**。
   */
  it('流式吐到一半:说「正在输出」,不许说画不了', () => {
    for (const half of ['<div><p>写了一半', '<table><tr><td>还在吐', '<p>x</p><!-- 注释没写完']) {
      const r = parseHtmlSubset(half)
      expect(r.ok, half).toBe(false)
      if (r.ok) continue
      expect(htmlFallbackNote(r.reason), half).toBe('正在输出…')
    }
  })

  it('真画不了的,说清是哪一种', () => {
    const note = (src: string) => {
      const r = parseHtmlSubset(src)
      if (r.ok) throw new Error(`本该退回:${src}`)
      return htmlFallbackNote(r.reason)
    }
    // 纯 CSS 柱状图:意思全在样式里,丢了样式就是一叠看不见的空 View
    expect(note('<div><div style="width:80%"></div><div style="width:40%"></div></div>')).toBe('这段是用样式画的')
    // 矢量图:整棵丢掉之后一个字都不剩
    expect(note('<svg><circle/></svg>')).toBe('这段没有文字')
    expect(note('<p>' + 'x'.repeat(HTML_MAX_LEN) + '</p>')).toBe('太长了')
    expect(note('<div>'.repeat(40) + 'x' + '</div>'.repeat(40))).toBe('嵌套太深')
    // 结构真的坏了(闭标签对不上)
    expect(note('<div><p>x</div></p>')).toBe('结构读不懂')
  })

  it('★这句话每一种都不是「手机端不渲染」—— 那句话现在一个字都不该再出现', () => {
    for (const r of ['unclosed-tag', 'css-only', 'no-text', 'empty', 'too-long', 'too-deep', 'mismatched-close', '什么怪东西']) {
      expect(htmlFallbackNote(r)).not.toContain('不渲染')
    }
  })
})
