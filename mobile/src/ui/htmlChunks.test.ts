import { describe, it, expect } from 'vitest'
import { splitHtmlChunks, BLOCK_OPEN_TAGS } from './htmlChunks'
import { parseHtmlSubset } from './htmlParse'

const kinds = (s: string) => splitHtmlChunks(s).map((c) => c.kind).join(',')

describe('splitHtmlChunks', () => {
  it('纯文字一个块,原样不动', () => {
    const s = '先看现在的放行逻辑。\nemitNote 只在循环外调了一次。'
    expect(splitHtmlChunks(s)).toEqual([{ kind: 'text', text: s }])
  })

  // 真机上撞见的那一段:代理在回答中间吐了一坨卡片布局的 HTML,把正文推出了四五屏。
  it('把中间那段 HTML 折出来,前后的正文各自留着', () => {
    const s = [
      '要点如下:',
      '',
      '<div style="display:flex; gap:8px;">',
      '  <div style="flex:1;">输出偏好</div>',
      '  <div style="flex:1;">HTML 约束</div>',
      '</div>',
      '',
      '工作目录是 /Users/zghua/work。你想让我做什么?',
    ].join('\n')
    const out = splitHtmlChunks(s)
    expect(out.map((c) => c.kind)).toEqual(['text', 'html', 'text'])
    expect(out[0].text).toContain('要点如下')
    expect(out[1].text).toContain('display:flex')
    expect(out[1].text.endsWith('</div>')).toBe(true)
    expect(out[2].text).toContain('你想让我做什么')
  })

  it('嵌套同名标签要数到配平,不能在第一个 </div> 就收手', () => {
    const s = '<div>\n  <div>a</div>\n  <div>b</div>\n</div>\n收尾这句必须留在外面'
    const out = splitHtmlChunks(s)
    expect(out.map((c) => c.kind)).toEqual(['html', 'text'])
    expect(out[0].text.split('\n')).toHaveLength(4)
    expect(out[1].text).toBe('收尾这句必须留在外面')
  })

  // ★这几条是防「误折」的。折错 = 把正常内容藏起来,比不折严重得多。
  it('行内标签不算 —— 混在句子里的 <b>/<code> 很正常', () => {
    expect(kinds('这里有 <b>加粗</b> 和 <code>行内代码</code>,都不该折。')).toBe('text')
  })

  it('句中出现的 <div 不算 —— 必须是某一行以它起头', () => {
    expect(kinds('我打算写一个 <div> 容器来放这些卡片。')).toBe('text')
  })

  it('缩进四格以上的 <div> 是 markdown 代码块,不折', () => {
    expect(kinds('示例:\n\n    <div style="x">\n    </div>')).toBe('text')
  })

  it('代理被打断、片段没闭合时,吃到结尾而不是把后面的正文吞掉一半', () => {
    const out = splitHtmlChunks('前言\n<div style="a">\n  <div>没写完')
    expect(out.map((c) => c.kind)).toEqual(['text', 'html'])
    expect(out[1].text).toContain('没写完')
  })

  it('空字符串不炸', () => {
    expect(splitHtmlChunks('')).toEqual([])
  })
})

describe('切块和解析必须对得上', () => {
  /**
   * ★★这条断言存在的理由,是一个真实烂了很久的 bug。
   *
   * `BLOCK_OPEN`(这个文件)决定「哪一行开始算一段 HTML 片段」,`htmlParse.ts` 的白名单决定
   * 「这段片段画不画得出来」。两份名单各写各的、谁也没钉住谁 —— 于是
   * `section` / `figure` / `details` / `dl` 在这儿是片段起点,在那儿一个都不认:
   * **每次都被切出来、每次都画不了、每次都折成「手机端不渲染」**。用户的原话是
   * 「很多内容看不到」,根因就是这个。
   *
   * 所以这里不比名单(比名单还是两份东西),而是**逐个跑一遍真的解析**。
   */
  it('BLOCK_OPEN 里的每个标签,切出来之后都画得动', () => {
    for (const tag of BLOCK_OPEN_TAGS) {
      if (tag === 'svg') continue      // 见下面单独那条
      const src = `<${tag}>能看见的字</${tag}>`
      const chunks = splitHtmlChunks(src)
      expect(chunks, tag).toEqual([{ kind: 'html', text: src }])
      const parsed = parseHtmlSubset(src)
      expect(parsed.ok, `${tag} 被切成 HTML 片段,却画不出来 ⇒ 必然折成「手机端不渲染」`).toBe(true)
    }
  })

  it('svg 是**有意**画不出来的那一个 —— 折叠占位会诚实地说「图形」', () => {
    // 矢量图我们确实画不了(整棵丢掉,理由见 htmlParse 的 DROP_SUBTREE)。
    // 它留在 BLOCK_OPEN 里是为了让它走折叠占位那条路,而不是把一堆 path 数据当正文吐出来。
    expect(splitHtmlChunks('<svg><circle/></svg>')).toEqual([{ kind: 'html', text: '<svg><circle/></svg>' }])
    expect(parseHtmlSubset('<svg><circle/></svg>').ok).toBe(false)
  })
})
