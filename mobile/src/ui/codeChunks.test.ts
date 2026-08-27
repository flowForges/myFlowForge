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
})
