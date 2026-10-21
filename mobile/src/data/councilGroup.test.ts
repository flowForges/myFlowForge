import { describe, it, expect } from 'vitest'
import type { CouncilTag } from '../../../src/shared/council'
import { councilHeader, groupCouncil, isCouncilGroup, splitCouncil } from './councilGroup'

type M = { id: string; who: 'user' | 'ai'; text: string; council?: CouncilTag }
const plain = (id: string, who: 'user' | 'ai' = 'ai'): M => ({ id, who, text: id })
const cm = (id: string, cid: string, stage: CouncilTag['stage'], round?: number, who: 'user' | 'ai' = 'ai', seat?: string): M =>
  ({ id, who, text: id, council: { id: cid, stage, round, seat } })

describe('groupCouncil —— 一场共商收成一个区块', () => {
  it('普通 / 共商 / 普通:区块落在它第一条消息的位置,前后普通消息顺序不变', () => {
    const out = groupCouncil([
      plain('u1', 'user'), plain('a1'),
      cm('t', 'c1', 'topic', undefined, 'user'), cm('s1', 'c1', 'answer', 1), cm('s2', 'c1', 'answer', 1),
      plain('u2', 'user'), plain('a2'),
    ])
    expect(out.map(e => (isCouncilGroup(e) ? `council:${e.id}` : e.id))).toEqual(['u1', 'a1', 'council:c1', 'u2', 'a2'])
    const g = out[2]
    expect(isCouncilGroup(g) && g.messages.map(m => m.id)).toEqual(['t', 's1', 's2'])
  })

  it('★区块之后才到的同一场消息(追问)也归进原区块,不在普通对话里另起一段', () => {
    const out = groupCouncil([cm('t', 'c1', 'topic', undefined, 'user'), plain('u2', 'user'), cm('f', 'c1', 'followup', undefined, 'user')])
    expect(out).toHaveLength(2)
    const g = out[0]
    expect(isCouncilGroup(g) && g.messages.map(m => m.id)).toEqual(['t', 'f'])
  })

  it('一个会话里两场共商是两个独立区块', () => {
    const out = groupCouncil([cm('a', 'c1', 'topic'), plain('x'), cm('b', 'c2', 'topic')])
    expect(out.map(e => (isCouncilGroup(e) ? e.id : e.id))).toEqual(['c1', 'x', 'c2'])
  })

  it('没有共商时原样返回每一条', () => {
    const msgs = [plain('a'), plain('b')]
    expect(groupCouncil(msgs)).toEqual(msgs)
  })
})

describe('splitCouncil —— 议题 / 各轮 / 最终 / 追问', () => {
  it('★追问之后的消息全归追问段;最终结果单独拿出来', () => {
    const r = splitCouncil([
      cm('t', 'c', 'topic', undefined, 'user'),
      cm('a1', 'c', 'answer', 1), cm('s1', 'c', 'summary', 1),
      cm('a2', 'c', 'critique', 2),
      cm('fin', 'c', 'final', 2),
      cm('q', 'c', 'followup', undefined, 'user'), cm('qa', 'c', 'followup', 2),
    ])
    expect(r.topic?.id).toBe('t')
    expect(r.final?.id).toBe('fin')
    expect(r.rounds.map(([n, l]) => [n, l.map(m => m.id)])).toEqual([[1, ['a1', 's1']], [2, ['a2']]])
    expect(r.followups.map(m => m.id)).toEqual(['q', 'qa'])
  })
})

describe('councilHeader —— 和电脑端同一行字', () => {
  it('议题取前 20 个字;用时按分钟四舍五入,不足 1 分钟算 1', () => {
    expect(councilHeader({ topic: '  一二三四五六七八九十一二三四五六七八九十多出来的  ', seats: 4, rounds: 2, elapsedMs: 18 * 60_000 + 10_000 }))
      .toBe('AI 共商 · 一二三四五六七八九十一二三四五六七八九十 · 4 方 · 2 轮 · 18 分钟')
    expect(councilHeader({ topic: 'x', seats: 2, rounds: 1, elapsedMs: 5_000 })).toBe('AI 共商 · x · 2 方 · 1 轮 · 1 分钟')
    expect(councilHeader({ topic: 'x', seats: 2, rounds: 0, elapsedMs: 0 })).toBe('AI 共商 · x · 2 方 · 0 轮 · 0 分钟')
  })
})
