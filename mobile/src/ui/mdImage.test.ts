import { describe, it, expect } from 'vitest'
import { parseMarkdown } from './mdParse'
import { isRemoteSrc } from './mdImage'

/**
 * ★★手机端图片:**只放行本地图,远程 src 照旧降级成链接。**
 *
 * 原来的规则是「所有图都降级成链接」,理由写在 mdParse.ts / htmlParse.ts 里:
 * 「远程 src 是追踪信标 + 出口 IP 泄露,这个渲染器一个网络请求都不发」。那条约束**不拆** ——
 * 它针对的是第三方地址。本地图走的是已经鉴权的网关(`file:image` 路由到 host),
 * 不碰任何第三方,所以可以画。
 */

const el = (nodes: ReturnType<typeof parseMarkdown>, i = 0) => nodes[i] as Extract<(typeof nodes)[number], { t: 'el' }>

describe('isRemoteSrc', () => {
  it('http/https/协议相对 → 远程', () => {
    for (const s of ['http://x/a.png', 'https://x/a.png', '//x/a.png']) expect(isRemoteSrc(s), s).toBe(true)
  })
  it('本地路径 → 不是远程', () => {
    for (const s of ['./a.png', 'out/a.png', '/Users/x/a.png', '../a.png', 'a.png']) expect(isRemoteSrc(s), s).toBe(false)
  })
  it('★data: 也当远程挡掉 —— 模型可以塞一整张图进正文,而那是 base64 炸弹', () => {
    expect(isRemoteSrc('data:image/png;base64,AAAA')).toBe(true)
  })
})

describe('parseMarkdown 里的图片', () => {
  it('★★整行就是一张本地图 → 出 img 节点(以前是一条 🖼 链接)', () => {
    const n = parseMarkdown('![流程图](./out/chart.png)')
    expect(el(n).tag).toBe('img')
    expect(el(n).href).toBe('./out/chart.png')
    expect(el(n).alt).toBe('流程图')
  })

  it('★★绝对路径同样出 img —— 模型跑完命令写的就是绝对路径', () => {
    expect(el(parseMarkdown('![截图](/ws/out/shot.png)')).tag).toBe('img')
  })

  it('★远程图仍然降级成链接,一个网络请求都不发', () => {
    const n = parseMarkdown('![banner](https://tracker.example/pixel.png)')
    const p = el(n)
    expect(p.tag).toBe('p')
    const a = p.kids.find((k) => k.t === 'el' && k.tag === 'a')
    expect(a).toBeTruthy()
  })

  it('★夹在句子中间的图**不**升级成块 —— 保持链接,别把一句话劈成三段', () => {
    const n = parseMarkdown('见 ![图](./a.png) 这里')
    expect(el(n).tag).toBe('p')
  })

  it('图前后有空格/首尾空白也算整行', () => {
    expect(el(parseMarkdown('   ![图](./a.png)   ')).tag).toBe('img')
  })

  it('没有 alt 时 alt 为空串,不编一个出来', () => {
    expect(el(parseMarkdown('![](./a.png)')).alt).toBe('')
  })

  it('连着两行图 → 两个 img 节点', () => {
    const n = parseMarkdown('![a](./a.png)\n![b](./b.png)')
    expect(n.map((x) => (x.t === 'el' ? x.tag : 'text'))).toEqual(['img', 'img'])
  })

  it('★图不该吃掉它后面的正文', () => {
    const n = parseMarkdown('![a](./a.png)\n\n后面这段话要在')
    expect(el(n, 0).tag).toBe('img')
    expect(el(n, 1).tag).toBe('p')
  })
})
