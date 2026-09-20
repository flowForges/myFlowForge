import { describe, it, expect } from 'vitest'
import { foldA11yLabel, foldCaret, needsYouHead, needsYouView } from './needsYouView'

/** 期望值写死字面量,不拿被测函数自己拼 —— 那样文案一变两边一起变,永远绿。 */
describe('「需要你」折叠之后还剩什么', () => {
  it('头上带着数', () => {
    expect(needsYouHead(4, 2)).toBe('4 条等你 · 2 道门')
    expect(needsYouHead(1, 0)).toBe('1 条等你')
  })

  it('★没有门的时候不许写「· 0 道门」', () => {
    expect(needsYouHead(3, 0)).toBe('3 条等你')
  })

  it('★★折起来仍然画,而且头一字不差 —— 折叠只准藏细节,不准藏「有事等你」这个事实', () => {
    const open = needsYouView(4, 2, false)
    const shut = needsYouView(4, 2, true)
    expect(open).toEqual({ render: true, head: '4 条等你 · 2 道门', rows: 4 })
    expect(shut).toEqual({ render: true, head: '4 条等你 · 2 道门', rows: 0 })
  })

  it('★★挂着门的时候折起来也照样画 —— 一个能把门藏没的折叠会让整块的承诺变成谎话', () => {
    const v = needsYouView(1, 1, true)
    expect(v.render).toBe(true)
    expect(v.render && v.head).toBe('1 条等你 · 1 道门')
  })

  it('真的一件事都没有:整块不画,折不折都一样', () => {
    expect(needsYouView(0, 0, false)).toEqual({ render: false })
    expect(needsYouView(0, 0, true)).toEqual({ render: false })
  })

  it('三角和无障碍标签跟着状态走,收起时把数念出来', () => {
    expect(foldCaret(false)).toBe('▾')
    expect(foldCaret(true)).toBe('▸')
    expect(foldA11yLabel(true, 4, 2)).toBe('展开:4 条等你 · 2 道门')
    expect(foldA11yLabel(false, 4, 2)).toBe('收起')
  })
})
