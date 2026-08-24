import { describe, it, expect } from 'vitest'
import { splitHtmlChunks } from './htmlChunks'

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
