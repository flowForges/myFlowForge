import { describe, it, expect } from 'vitest'
import { splitCodeChunks } from './codeChunks'

describe('splitCodeChunks', () => {
  it('围栏切出一个代码块,前后的文字各自成块', () => {
    expect(splitCodeChunks('看这个:\n```sh\nnpm run dev\n```\n就这样')).toEqual([
      { kind: 'text', text: '看这个:' },
      { kind: 'code', text: 'npm run dev', lang: 'sh' },
      { kind: 'text', text: '就这样' },
    ])
  })

  it('没写语言的围栏照样切,lang 是空串', () => {
    expect(splitCodeChunks('```\nls -la\n```')).toEqual([{ kind: 'code', text: 'ls -la', lang: '' }])
  })

  it('★信息串带参数时只取第一个词当语言(```tsx title=a.ts 是常见写法)', () => {
    expect(splitCodeChunks('```tsx title=a.tsx\nconst a = 1\n```')).toEqual([
      { kind: 'code', text: 'const a = 1', lang: 'tsx' },
    ])
  })

  it('代码内部原样保留:空行、缩进、里面的 HTML 一个字不动', () => {
    const src = '```html\n<div>\n  <b>hi</b>\n\n</div>\n```'
    expect(splitCodeChunks(src)).toEqual([
      { kind: 'code', text: '<div>\n  <b>hi</b>\n\n</div>', lang: 'html' },
    ])
  })

  it('一条消息里的多个围栏各自成块', () => {
    expect(splitCodeChunks('a\n```\nx\n```\nb\n```\ny\n```')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'code', text: 'x', lang: '' },
      { kind: 'text', text: 'b' },
      { kind: 'code', text: 'y', lang: '' },
    ])
  })

  it('★还没闭合的围栏(代理正在吐字)也当代码块,不是等它写完才忽然换个样子', () => {
    expect(splitCodeChunks('在改:\n```ts\nconst a =')).toEqual([
      { kind: 'text', text: '在改:' },
      { kind: 'code', text: 'const a =', lang: 'ts' },
    ])
  })

  it('空围栏不留痕(代理结尾常多吐一对 ```)', () => {
    expect(splitCodeChunks('说完了\n```\n```')).toEqual([{ kind: 'text', text: '说完了' }])
  })

  it('★行内代码不算围栏 —— 认错一行就会把后面整段吞进代码块', () => {
    // ★这一条**必须让行内代码顶在行首**才试得到那道守卫:开围栏本来就要求它在行首,
    //  写成「用 ```x``` 跑起来」的话根本走不到判断那一步(变异测试当场抓到这条断言是假绿的)。
    expect(splitCodeChunks('```npm run dev``` 就跑起来了\n然后打开浏览器')).toEqual([
      { kind: 'text', text: '```npm run dev``` 就跑起来了\n然后打开浏览器' },
    ])
    expect(splitCodeChunks('用 ```npm run dev``` 跑起来\n然后打开浏览器')).toEqual([
      { kind: 'text', text: '用 ```npm run dev``` 跑起来\n然后打开浏览器' },
    ])
  })

  it('★缩进 4 格的不是围栏(那是缩进代码块的写法,不能当围栏吃到结尾)', () => {
    expect(splitCodeChunks('    ```\n    还是文字')).toEqual([
      { kind: 'text', text: '    ```\n    还是文字' },
    ])
  })

  it('~~~ 也是围栏,而且不会被 ``` 关掉', () => {
    expect(splitCodeChunks('~~~py\nprint(1)\n~~~')).toEqual([{ kind: 'code', text: 'print(1)', lang: 'py' }])
    expect(splitCodeChunks('~~~\na```b\n~~~')).toEqual([{ kind: 'code', text: 'a```b', lang: '' }])
  })

  it('闭围栏可以更长,但不能更短(CommonMark 的规矩)', () => {
    expect(splitCodeChunks('````\n```\n还在里面\n````')).toEqual([
      { kind: 'code', text: '```\n还在里面', lang: '' },
    ])
  })

  it('一段没有围栏的正文原样出来,不多切一刀', () => {
    expect(splitCodeChunks('第一行\n第二行')).toEqual([{ kind: 'text', text: '第一行\n第二行' }])
  })

  it('空正文切出空数组(流式的第一帧就是空的)', () => {
    expect(splitCodeChunks('')).toEqual([])
  })

  /**
   * ★★没闭合的围栏「吃到结尾」在流式吐字时是对的(见实现里那段注释),但代理**漏写收尾围栏**时
   *  它会把整条回复的后半段(表格首当其冲)全吞进一个代码块。电脑端早就有这条兜底
   *  (`views/chat/markdown.tsx`),手机端一直没有 —— 2026-09-01 做 markdown 渲染时发现的。
   *
   * 兜底只认**一个**信号:被吞的内容里出现了 GFM 表格(某一行带 `|`,下一行是带 `|` 的分隔行)。
   * 真代码里几乎不会出现 `|---|---|`(ASCII 表格画的是 `+---+`),所以不会误伤被截断的代码;
   * 已经正常闭合的围栏**完全不走这条路**(引用文档里的表格照样是代码)。
   */
  describe('没闭合的围栏 · 表格兜底', () => {
    it('★后面跟着一张表格时,围栏在表格前面截断', () => {
      const src = '看这个:\n```sh\nnpm run dev\n\n| 位置 | 行为 |\n|---|---|\n| a.go | 建单 |'
      expect(splitCodeChunks(src)).toEqual([
        { kind: 'text', text: '看这个:' },
        { kind: 'code', text: 'npm run dev\n', lang: 'sh' },
        { kind: 'text', text: '| 位置 | 行为 |\n|---|---|\n| a.go | 建单 |' },
      ])
    })

    it('里面没有表格就照旧吃到结尾 —— 流式吐到一半的那一帧全靠这个', () => {
      expect(splitCodeChunks('```sh\nnpm run dev\nnpm test')).toEqual([
        { kind: 'code', text: 'npm run dev\nnpm test', lang: 'sh' },
      ])
    })

    it('★正常闭合的围栏里含表格,一个字都不许动 —— 那是「在讲 markdown」', () => {
      const src = '```md\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n```'
      expect(splitCodeChunks(src)).toEqual([
        { kind: 'code', text: '| 甲 | 乙 |\n|---|---|\n| 1 | 2 |', lang: 'md' },
      ])
    })

    it('★ASCII 表格(`+---+`)不是信号,不许拿它截断真代码', () => {
      const src = '```\n+-----+\n| a   |\n+-----+'
      expect(splitCodeChunks(src)).toEqual([{ kind: 'code', text: '+-----+\n| a   |\n+-----+', lang: '' }])
    })

    it('★分隔行必须**紧跟**带竖线的那一行,隔一行不算', () => {
      const src = '```\n| 甲 |\n还有一句\n|---|'
      expect(splitCodeChunks(src)).toEqual([{ kind: 'code', text: '| 甲 |\n还有一句\n|---|', lang: '' }])
    })
  })
})
