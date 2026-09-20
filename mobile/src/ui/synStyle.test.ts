import { describe, it, expect } from 'vitest'
import type { TokenClass } from '@shared/highlight'
import { DARK, LIGHT } from '../theme/tokens'
import { synStyle } from './synStyle'

/**
 * 这份映射是**照抄**电脑端 `src/renderer/views/chat/chat.css` 的 `.code-block .t-*`(836–846 行)的。
 * 抄错了没有任何东西会报错 —— 只会在某一套主题下注释和正文一个颜色,或者 HTML 标签名忽然和别处不一样。
 */
const ALL: TokenClass[] = ['kw', 'st', 'cm', 'nu', 'fn', 'ty', 'pr', 'op', 'tg', 'at', 'va']

describe('synStyle', () => {
  it('11 个 token 类都有颜色,没有一个漏成 undefined', () => {
    for (const cls of ALL) {
      expect(synStyle(cls, DARK).color, cls).toBeTruthy()
      expect(synStyle(cls, LIGHT).color, cls).toBeTruthy()
    }
  })

  it('直落的 9 个色位对上令牌', () => {
    expect(synStyle('kw', DARK).color).toBe(DARK.synKw)
    expect(synStyle('st', DARK).color).toBe(DARK.synSt)
    expect(synStyle('cm', DARK).color).toBe(DARK.synCm)
    expect(synStyle('nu', DARK).color).toBe(DARK.synNu)
    expect(synStyle('fn', DARK).color).toBe(DARK.synFn)
    expect(synStyle('ty', DARK).color).toBe(DARK.synTy)
    expect(synStyle('pr', DARK).color).toBe(DARK.synPr)
    expect(synStyle('op', DARK).color).toBe(DARK.synOp)
    expect(synStyle('va', DARK).color).toBe(DARK.synVa)
  })

  it('★11 个类共用 9 个色位:tg 跟关键字、at 跟键/属性(chat.css 就是这么合的)', () => {
    expect(synStyle('tg', DARK).color).toBe(DARK.synKw)
    expect(synStyle('at', DARK).color).toBe(DARK.synPr)
    expect(synStyle('tg', LIGHT).color).toBe(LIGHT.synKw)
    expect(synStyle('at', LIGHT).color).toBe(LIGHT.synPr)
  })

  it('★只有注释是斜体,别的一个都不许带 —— 等宽字里加样式会破坏列对齐', () => {
    expect(synStyle('cm', DARK).fontStyle).toBe('italic')
    for (const cls of ALL.filter((x) => x !== 'cm')) {
      expect(synStyle(cls, DARK).fontStyle, cls).toBeUndefined()
    }
  })

  it('★深浅两套都得有值,而且不能是同一个 —— 同一个色值两套主题下必有一套看不清', () => {
    for (const cls of ALL) {
      expect(synStyle(cls, DARK).color, cls).not.toBe(synStyle(cls, LIGHT).color)
    }
  })
})
