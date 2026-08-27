import { describe, expect, it } from 'vitest'
import { maskToken } from './tokenMask'

describe('maskToken', () => {
  it('一个原字符都不露', () => {
    const t = 'sk-live-9f3aQ'
    const m = maskToken(t)
    // 逐字符查,而不是 `not.toContain(t)` —— 后者只在**整串**出现时才红,
    // 「只露后 4 位」那种实现照样能骗过它。
    for (const ch of new Set(t)) expect(m).not.toContain(ch)
    expect(m).toBe('•••••••••••••')
  })

  it('短令牌逐位遮罩', () => {
    // 字面量钉死,不写成 `'•'.repeat(t.length)` —— 那样把实现抄进了断言,
    // 实现改成别的长度公式时断言会跟着一起动,永远是绿的。
    expect(maskToken('abc')).toBe('•••')
    expect(maskToken('ab')).toBe('••')
  })

  it('长令牌封顶在 24 个点,不泄露真实长度', () => {
    const a = maskToken('x'.repeat(40))
    const b = maskToken('y'.repeat(100))
    expect(a).toBe('••••••••••••••••••••••••')
    expect(a.length).toBe(24)
    // 两条长度不同的令牌遮罩出来必须**一模一样**,否则点数就是长度。
    expect(b).toBe(a)
  })

  it('刚好 24 位不被截短', () => {
    expect(maskToken('z'.repeat(24)).length).toBe(24)
    expect(maskToken('z'.repeat(23)).length).toBe(23)
  })

  it('没有令牌就是空串,文案交给界面', () => {
    expect(maskToken('')).toBe('')
  })
})
