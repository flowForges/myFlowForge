import { describe, it, expect } from 'vitest'
import { HAPTIC_EVENTS, hapticKindFor, tap } from './haptics'

describe('触感', () => {
  it('★每一个事件都有一档强度 —— 漏一个就是那个动作**手上没反应**,而屏幕上看不出来', () => {
    for (const ev of HAPTIC_EVENTS) expect(hapticKindFor(ev), ev).toBeTruthy()
  })

  it('破坏性动作用 warning,不是 success —— 归档/删除完成时震出一声「好的」是误导', () => {
    expect(hapticKindFor('destructive')).toBe('warning')
  })

  it('普通点击**不在**这张表里 —— 每一下都震就等于没震', () => {
    expect(HAPTIC_EVENTS).not.toContain('tap' as never)
  })

  it('★★模块不可用时 tap() 必须静默返回,绝不抛 —— 一个可选的震动不许炸掉功能路径', () => {
    // 旧包里没有 expo-haptics。它把整条「左滑到位」或者「切 tab」的路径炸掉,
    // 就是拿一个锦上添花的东西换掉了一个真功能。
    expect(() => { for (const ev of HAPTIC_EVENTS) tap(ev) }).not.toThrow()
  })
})
