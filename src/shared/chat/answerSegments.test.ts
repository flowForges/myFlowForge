import { describe, it, expect } from 'vitest'
import { inlineAnswers, splitByAnswers } from './answerSegments'

describe('splitByAnswers —— 把「你的选择」插回它被回答的那个位置', () => {
  it('没有选择:整段正文一块', () => {
    expect(splitByAnswers('hello', undefined)).toEqual([{ kind: 'text', text: 'hello' }])
    expect(splitByAnswers('hello', [])).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('答在中间:前文 → 选择 → 后文', () => {
    expect(splitByAnswers('问你一下好了,继续', [{ at: 7, text: 'A' }])).toEqual([
      { kind: 'text', text: '问你一下好了,' },
      { kind: 'answer', text: 'A' },
      { kind: 'text', text: '继续' },
    ])
  })

  it('at=0:选择在最前,不留空的前文块', () => {
    expect(splitByAnswers('后文', [{ at: 0, text: 'A' }])).toEqual([
      { kind: 'answer', text: 'A' },
      { kind: 'text', text: '后文' },
    ])
  })

  it('at=len:选择在最后(代理还没接着说)', () => {
    expect(splitByAnswers('前文', [{ at: 2, text: 'A' }])).toEqual([
      { kind: 'text', text: '前文' },
      { kind: 'answer', text: 'A' },
    ])
  })

  it('多个选择:各归各位,乱序进来也按位置排', () => {
    expect(splitByAnswers('aabbcc', [{ at: 4, text: 'Y' }, { at: 2, text: 'X' }])).toEqual([
      { kind: 'text', text: 'aa' },
      { kind: 'answer', text: 'X' },
      { kind: 'text', text: 'bb' },
      { kind: 'answer', text: 'Y' },
      { kind: 'text', text: 'cc' },
    ])
  })

  it('同一位置两个选择:按到达顺序挨着放', () => {
    expect(splitByAnswers('ab', [{ at: 1, text: 'X' }, { at: 1, text: 'Y' }])).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'answer', text: 'X' },
      { kind: 'answer', text: 'Y' },
      { kind: 'text', text: 'b' },
    ])
  })

  it('锚点超出正文(assistant-replace 改短了)夹到末尾;负数夹到 0', () => {
    expect(splitByAnswers('短', [{ at: 99, text: 'X' }, { at: -3, text: 'Z' }])).toEqual([
      { kind: 'answer', text: 'Z' },
      { kind: 'text', text: '短' },
      { kind: 'answer', text: 'X' },
    ])
  })

  it('空正文:只有选择', () => {
    expect(splitByAnswers('', [{ at: 5, text: 'X' }])).toEqual([{ kind: 'answer', text: 'X' }])
  })
})

describe('inlineAnswers —— 喂模型的历史里选择也在原位', () => {
  it('没有选择:原文不动', () => {
    expect(inlineAnswers('abc', undefined)).toBe('abc')
  })
  it('选择插在原位,前后空一行', () => {
    expect(inlineAnswers('前文后文', [{ at: 2, text: '选了 A' }])).toBe('前文\n\n选了 A\n\n后文')
  })
})
