import { describe, it, expect } from 'vitest'
import { tierOf, countTiers, topTier, TIER_LABEL, type SessionTier } from './sessionStatus'

describe('tierOf —— 一条会话只显示最高的那一档', () => {
  it('门压过一切', () => {
    expect(tierOf({ hasGate: true, running: true, unread: true })).toBe('gate')
  })
  it('没门就看在不在跑', () => {
    expect(tierOf({ hasGate: false, running: true, unread: true })).toBe('running')
  })
  // ★这条是设计的核心:正在跑的**不冒未读**,因为它已经在「运行中」那一档了。
  //  不这么定的话,一条跑着的会话会同时是「运行中」和「未读」,而界面上只有一个位置。
  it('在跑的不冒未读', () => {
    expect(tierOf({ hasGate: false, running: true, unread: true })).not.toBe('unread')
  })
  it('停下来了且有没看过的东西 = 未读', () => {
    expect(tierOf({ hasGate: false, running: false, unread: true })).toBe('unread')
  })
  it('什么都没有 = 歇着', () => {
    expect(tierOf({ hasGate: false, running: false, unread: false })).toBe('idle')
  })
})

describe('countTiers / topTier —— 气泡只显示最高的那一档', () => {
  const tiers = (s: string): SessionTier[] => s.split('') .map((ch) =>
    ch === 'g' ? 'gate' : ch === 'r' ? 'running' : ch === 'u' ? 'unread' : 'idle')

  it('分别数出三档的条数,歇着的不数', () => {
    expect(countTiers(tiers('ggriiu'))).toEqual({ gate: 2, running: 1, unread: 1 })
  })
  it('三档都有时,顶上去的是门', () => {
    expect(topTier(countTiers(tiers('gru')))).toBe('gate')
  })
  it('没门就轮到运行中', () => {
    expect(topTier(countTiers(tiers('ru')))).toBe('running')
  })
  it('只剩未读就是未读', () => {
    expect(topTier(countTiers(tiers('uii')))).toBe('unread')
  })
  // ★全空返回 null,而不是 'idle'。气泡的调用方靠这个 null 决定**整个气泡不出现** ——
  //  返回 'idle' 会让它画出一个「0 条歇着」的气泡,那正是我们要避免的噪音。
  it('全是歇着 = null(气泡整个不出现)', () => {
    expect(topTier(countTiers(tiers('iiii')))).toBeNull()
  })
})

describe('TIER_LABEL', () => {
  it('三档都有词,而且门那一档同时盖住「允许一下」和「回答一句」', () => {
    expect(TIER_LABEL.gate).toBe('等你答话')
    expect(TIER_LABEL.running).toBe('执行中')
    expect(TIER_LABEL.unread).toBe('未读')
  })
})
