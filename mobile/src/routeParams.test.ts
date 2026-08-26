import { describe, expect, it } from 'vitest'
import { one } from './routeParams'

describe('one()', () => {
  it('普通字符串原样给回来', () => {
    expect(one('abc')).toBe('abc')
    // 空串是**有效值**,不能被当成「没给」而变成别的东西。
    expect(one('')).toBe('')
  })

  it('数组取第一个 —— 同名参数出现两次时先到的那个算数', () => {
    expect(one(['first', 'second'])).toBe('first')
    expect(one(['only'])).toBe('only')
  })

  it('空数组退化成空串,不是 undefined', () => {
    // ★`[][0]` 是 `undefined`。少了 `?? ''` 这里就会把 `undefined` 当字符串交出去,
    //  调用方一个 `.trim()` 就炸,而返回类型上写着 `string`。
    expect(one([])).toBe('')
  })

  it('undefined(参数根本没给)退化成空串', () => {
    expect(one(undefined)).toBe('')
  })
})
