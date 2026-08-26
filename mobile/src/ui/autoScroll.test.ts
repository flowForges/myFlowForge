import { describe, it, expect } from 'vitest'
import { initialAutoScroll, nextScroll } from './autoScroll'

const run = (counts: number[]) => {
  let s = initialAutoScroll()
  return counts.map((n) => {
    const r = nextScroll(s, n)
    s = r.state
    return r.scroll
  })
}

describe('autoScroll', () => {
  it('★进屏那一次(0 → N)瞬间到位,不带动画', () => {
    expect(run([0, 12])).toEqual([false, { animated: false }])
  })

  it('之后来的新消息才带动画', () => {
    expect(run([0, 12, 13, 14])).toEqual([
      false,
      { animated: false },
      { animated: true },
      { animated: true },
    ])
  })

  it('一条消息都没有时不滚 —— 空会话滚一下会闪', () => {
    expect(run([0, 0])).toEqual([false, false])
  })

  it('★换会话(被清回 0)之后,新会话的首帧重新变成「瞬间到位」', () => {
    expect(run([0, 12, 13, 0, 40])).toEqual([
      false,
      { animated: false },
      { animated: true },
      false,
      { animated: false },
    ])
  })

  it('数量没变就不重复滚(重渲染不该把人从上面拽到底下)', () => {
    expect(run([0, 12, 12])).toEqual([false, { animated: false }, false])
  })
})
