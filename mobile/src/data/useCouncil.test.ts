import { describe, it, expect } from 'vitest'
import type { CouncilState } from '../../../src/shared/council'
import { activeCouncil, applyCouncilState, councilActionError, councilRoundLabel, isCouncilBreak, mergeCouncilSnapshot, submitTarget } from './useCouncil'

const st = (id: string, p: Partial<CouncilState> = {}): CouncilState => ({
  id,
  workspacePath: '/ws',
  sessionId: 'S',
  status: 'running',
  round: 1,
  totalRounds: 2,
  speaking: [],
  startedAt: 0,
  elapsedMs: 0,
  config: {
    topic: 't', attachments: [], seats: [], mode: { kind: 'rounds', rounds: 2 },
    leader: { id: 'leader:x', provider: 'claude', model: 'm', label: 'L' },
  },
  ...p,
})

describe('applyCouncilState —— council:state 只认本会话', () => {
  it('别的会话 / 别的工作区的推送原样忽略(同一个数组引用,不触发重渲染)', () => {
    const cur = [st('a')]
    expect(applyCouncilState(cur, st('b', { sessionId: 'OTHER' }), '/ws', 'S')).toBe(cur)
    expect(applyCouncilState(cur, st('b', { workspacePath: '/other' }), '/ws', 'S')).toBe(cur)
  })
  it('本会话的:新的追加,已有的按 id 原地替换', () => {
    const cur = [st('a'), st('b')]
    const next = applyCouncilState(cur, st('a', { status: 'paused' }), '/ws', 'S')
    expect(next.map(s => [s.id, s.status])).toEqual([['a', 'paused'], ['b', 'running']])
    expect(applyCouncilState(cur, st('c'), '/ws', 'S').map(s => s.id)).toEqual(['a', 'b', 'c'])
  })
  it('没选会话时一律忽略', () => {
    const cur: CouncilState[] = []
    expect(applyCouncilState(cur, st('a'), null, null)).toBe(cur)
  })
})

describe('mergeCouncilSnapshot —— 快照不盖掉已收到的推送', () => {
  it('同 id 以已有的为准,快照里没见过的补进来', () => {
    const cur = [st('a', { status: 'paused' })]
    const out = mergeCouncilSnapshot(cur, [st('a', { status: 'running' }), st('b')])
    expect(out.map(s => [s.id, s.status])).toEqual([['a', 'paused'], ['b', 'running']])
  })
})

describe('activeCouncil', () => {
  it('进行中的那一场:running / paused / finalizing;结束的不算', () => {
    expect(activeCouncil([st('a', { status: 'done' }), st('b', { status: 'paused' })])?.id).toBe('b')
    expect(activeCouncil([st('a', { status: 'aborted' })])).toBeUndefined()
    expect(activeCouncil([st('a', { status: 'finalizing' })])?.id).toBe('a')
  })
  it('暂停的不占会话(R9):有正在跑的就取正在跑的那场', () => {
    expect(activeCouncil([st('a', { status: 'paused' }), st('b', { status: 'running' })])?.id).toBe('b')
  })
})

describe('submitTarget —— 输入框提交走哪条路', () => {
  it('running 是插话;轮间等用户(paused + waitingForUser)也是插话(补充给下一轮)', () => {
    expect(submitTarget({ status: 'running' })).toBe('interject')
    expect(submitTarget({ status: 'paused', waitingForUser: true })).toBe('interject')
  })
  it('普通暂停 / 收尾 / 结束 / 没有共商:普通发送', () => {
    for (const s of ['paused', 'finalizing', 'done', 'aborted'] as const) expect(submitTarget({ status: s })).toBe('send')
    expect(submitTarget(undefined)).toBe('send')
  })
})

describe('councilRoundLabel —— 状态行的轮次', () => {
  it('轮间等用户:引擎已把 round 推到下一轮,说的是刚结束的那一轮', () => {
    expect(councilRoundLabel(st('a', { status: 'paused', waitingForUser: true, round: 2, totalRounds: 3 }))).toBe('第 1 轮结束')
  })
  it('其余:第 k / N 轮,不限轮数时第 k 轮', () => {
    expect(councilRoundLabel(st('a', { round: 2, totalRounds: 3 }))).toBe('第 2 / 3 轮')
    expect(councilRoundLabel(st('a', { status: 'paused', round: 2, totalRounds: null }))).toBe('第 2 轮')
  })
  it('isCouncilBreak 只认 paused + waitingForUser', () => {
    expect(isCouncilBreak(st('a', { status: 'paused', waitingForUser: true }))).toBe(true)
    expect(isCouncilBreak(st('a', { status: 'paused' }))).toBe(false)
    expect(isCouncilBreak(st('a', { status: 'running', waitingForUser: true }))).toBe(false)
    expect(isCouncilBreak(undefined)).toBe(false)
  })
})

describe('councilActionError', () => {
  it('认得的错误码给一句话,其余统一「操作失败」', () => {
    expect(councilActionError(new Error('not-done'))).toBe('共商尚未结束')
    expect(councilActionError(new Error("Error invoking remote method 'council:resume': Error: busy"), 'resume')).toBe('当前会话正忙')
    expect(councilActionError(new Error('busy'), 'followup')).toBe('正在回答上一个追问')
    expect(councilActionError(new Error('Error: target-invalid'))).toBe('配置无效')
    expect(councilActionError('boom')).toBe('操作失败')
  })
})
