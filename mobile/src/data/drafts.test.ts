import { describe, it, expect, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }))

import { draftKey, draftsFrom, putDraft, MAX_DRAFTS, MAX_DRAFT_LEN } from './drafts'

describe('drafts —— 每个会话没发出去的那段字', () => {
  it('★不同会话、不同工作区互不串', () => {
    const a = draftKey('/ws1', 's1'), b = draftKey('/ws1', 's2'), c = draftKey('/ws2', 's1')
    expect(new Set([a, b, c]).size).toBe(3)
    let m = putDraft(new Map(), a, '修一下登录页')
    m = putDraft(m, b, '跑测试')
    expect(m.get(a)).toBe('修一下登录页')
    expect(m.get(c)).toBeUndefined()
  })

  it('★清空(发出去了)就删掉,不留一条空草稿', () => {
    const k = draftKey('/w', 's')
    const m = putDraft(putDraft(new Map(), k, 'abc'), k, '   ')
    expect(m.has(k)).toBe(false)
  })

  it('超过上限从最早的开始丢,刚写的那条一定在', () => {
    let m = new Map<string, string>()
    for (let i = 0; i < MAX_DRAFTS + 5; i++) m = putDraft(m, `k${i}`, 'x')
    expect(m.size).toBe(MAX_DRAFTS)
    expect(m.has('k0')).toBe(false)
    expect(m.has(`k${MAX_DRAFTS + 4}`)).toBe(true)
    // 重新写一条老的:挪到最后,不会被下一次淘汰
    m = putDraft(m, 'k5', 'y')
    m = putDraft(m, 'new', 'z')
    expect(m.has('k5')).toBe(true)
  })

  it('超长截断,不丢整条', () => {
    const m = putDraft(new Map(), 'k', 'a'.repeat(MAX_DRAFT_LEN + 10))
    expect(m.get('k')).toHaveLength(MAX_DRAFT_LEN)
  })

  it('磁盘上的坏数据当空,不抛', () => {
    expect(draftsFrom(null).size).toBe(0)
    expect(draftsFrom('{坏的').size).toBe(0)
    expect(draftsFrom('{"a":1}').size).toBe(0)
    expect(draftsFrom(JSON.stringify([['k', 'v'], ['bad'], [1, 2], ['e', '']])).size).toBe(1)
  })
})
