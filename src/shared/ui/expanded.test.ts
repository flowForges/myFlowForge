import { describe, it, expect } from 'vitest'
import { toggleExpanded, ensureExpanded } from './expanded'

describe('expanded', () => {
  it('toggle 点一下切换', () => {
    let s = new Set<string>()
    s = toggleExpanded(s, '/w1'); expect(s.has('/w1')).toBe(true)
    s = toggleExpanded(s, '/w1'); expect(s.has('/w1')).toBe(false)
  })
  it('★能同时展开多个 —— 不是单选手风琴', () => {
    let s = toggleExpanded(new Set<string>(), '/w1')
    s = toggleExpanded(s, '/w2')
    expect([...s].sort()).toEqual(['/w1', '/w2'])
  })
  it('★不改原集合(调用方靠新引用触发重渲染)', () => {
    const s = new Set(['/w1'])
    const n = toggleExpanded(s, '/w2')
    expect([...s]).toEqual(['/w1'])
    expect(n).not.toBe(s)
  })
  it('ensureExpanded 只加不切:已展开的再进一次仍然是展开', () => {
    const s = new Set(['/w1'])
    expect(ensureExpanded(s, '/w1').has('/w1')).toBe(true)
    expect(ensureExpanded(s, '/w2').has('/w2')).toBe(true)
  })
  it('★ensureExpanded 已经在里面时返回**同一个引用** —— 调用方靠它跳过一次白存盘', () => {
    const s = new Set(['/w1'])
    expect(ensureExpanded(s, '/w1')).toBe(s)
  })
})
