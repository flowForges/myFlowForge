import { describe, it, expect } from 'vitest'
import type { CouncilState } from '../../../src/shared/council'
import { activeCouncil, applyCouncilState, councilActionError, mergeCouncilSnapshot, submitTarget } from './useCouncil'

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
  it("只有 running 才是插话", () => {
    expect(submitTarget('running')).toBe('interject')
    for (const s of ['paused', 'finalizing', 'done', 'aborted', undefined] as const) expect(submitTarget(s)).toBe('send')
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
