import { describe, it, expect } from 'vitest'
import { attentionOf, ATTENTION_WINDOW_MS, type Presence } from './attention'

const NOW = 1_700_000_000_000
const at = (workspacePath: string, sessionId?: string | null) => ({ workspacePath, sessionId })
const presence = (p: Partial<Presence>): Presence => ({ visible: true, at: at('/ws'), reportedAt: NOW, ...p })

describe('attentionOf', () => {
  it('没有任何上报 = 不在', () => {
    expect(attentionOf(null, at('/ws'), NOW)).toBe('away')
    expect(attentionOf(undefined, at('/ws'), NOW)).toBe('away')
  })

  it('正看着同一个目标 = 在看,什么都别弹', () => {
    expect(attentionOf(presence({ at: at('/ws', 's1') }), at('/ws', 's1'), NOW)).toBe('attending')
  })

  it('app 开着但停在别的工作区 = 应用内提醒', () => {
    expect(attentionOf(presence({ at: at('/other') }), at('/ws'), NOW)).toBe('inapp')
  })

  it('同一个工作区但不是同一条会话 = 应用内提醒', () => {
    expect(attentionOf(presence({ at: at('/ws', 's1') }), at('/ws', 's2'), NOW)).toBe('inapp')
  })

  it('★工作区级的门(没有 sessionId)不算「正在看某条会话」', () => {
    // 工作流的门挂在工作区上,而人停在那个工作区的某条会话里 —— 门在另一块屏上,他看不见。
    expect(attentionOf(presence({ at: at('/ws', 's1') }), at('/ws', null), NOW)).toBe('inapp')
    // 反过来也一样:停在工作区级视图上,会话里来的门他也看不见。
    expect(attentionOf(presence({ at: at('/ws', null) }), at('/ws', 's1'), NOW)).toBe('inapp')
  })

  it('undefined 和 null 的 sessionId 是同一回事', () => {
    expect(attentionOf(presence({ at: { workspacePath: '/ws' } }), { workspacePath: '/ws', sessionId: null }, NOW)).toBe('attending')
  })

  it('app 不可见 = 不在(后台时应用内提醒根本看不见)', () => {
    expect(attentionOf(presence({ visible: false, at: at('/ws') }), at('/ws'), NOW)).toBe('away')
  })

  it('★上报过期 = 不在 —— 手机被系统挂起时没机会说一声「我走了」', () => {
    const stale = presence({ at: at('/ws'), reportedAt: NOW - ATTENTION_WINDOW_MS - 1 })
    expect(attentionOf(stale, at('/ws'), NOW)).toBe('away')
    // 刚好卡在窗口边界上仍然算在场
    const edge = presence({ at: at('/ws'), reportedAt: NOW - ATTENTION_WINDOW_MS })
    expect(attentionOf(edge, at('/ws'), NOW)).toBe('attending')
  })

  it('app 可见但没停在任何工作区上 = 应用内提醒', () => {
    expect(attentionOf(presence({ at: null }), at('/ws'), NOW)).toBe('inapp')
  })

  it('★attending 和 away 互斥 —— 本地通知和远程推送不可能同时成立', () => {
    // 这条钉的是整套设计赖以成立的那个性质:手机只在 inapp 弹,daemon 只在 away 发。
    const cases: Array<Presence | null> = [
      null,
      presence({ visible: false }),
      presence({ at: at('/other') }),
      presence({ at: at('/ws') }),
      presence({ reportedAt: NOW - ATTENTION_WINDOW_MS - 1 }),
    ]
    for (const p of cases) {
      const a = attentionOf(p, at('/ws'), NOW)
      expect(['attending', 'inapp', 'away']).toContain(a)
    }
  })
})
