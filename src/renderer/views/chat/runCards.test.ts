import { describe, it, expect } from 'vitest'
import { toRunCardEntries } from './runCards'
import type { FrozenRunCard } from './runCards'
import type { RunEvent } from '../../../main/run/events'

const gate: RunEvent = { id: 'g1', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: 'approve design?' }
const failure: RunEvent = { id: 'f1', kind: 'failure', laneId: 'l1', stageKey: 'code', error: 'boom', attempts: 2 }

describe('toRunCardEntries', () => {
  it('未解决事件出 ACTIVE 条目,已解决(resolved 命中同 id)出 FROZEN 条目并从活卡里剔除', () => {
    const resolved: FrozenRunCard[] = [
      { id: 'g1', kind: 'gate', stageKey: 'design', title: 'approve design?', decision: 'advance', at: 200, ts: 100 },
    ]
    const entries = toRunCardEntries([gate, failure], resolved)

    expect(entries).toHaveLength(2)
    const active = entries.find((e) => e.id === 'f1')
    const frozen = entries.find((e) => e.id === 'g1')

    expect(active).toBeTruthy()
    expect(active?.event).toEqual(failure)
    expect(active?.frozen).toBeUndefined()

    expect(frozen).toBeTruthy()
    expect(frozen?.event).toBeUndefined()
    expect(frozen?.frozen?.decision).toBe('advance')
    expect(frozen?.frozen?.at).toBe(200)
  })

  it('按 ts 排序 —— frozen 用自身 ts,active 用 firstSeenAt 映射', () => {
    const resolved: FrozenRunCard[] = [
      { id: 'g1', kind: 'gate', stageKey: 'design', title: 'approve design?', decision: 'advance', at: 999, ts: 300 },
    ]
    const entries = toRunCardEntries([gate, failure], resolved, { f1: 50 })
    expect(entries.map((e) => e.id)).toEqual(['f1', 'g1']) // 50 < 300
  })

  it('无 firstSeenAt 映射时回退到 inbox 内的数组序,仍确定性', () => {
    const doubt: RunEvent = { id: 'd1', kind: 'doubt', laneId: 'l1', stageKey: 'code', note: 'hmm' }
    const entries = toRunCardEntries([failure, doubt], [])
    expect(entries.map((e) => e.id)).toEqual(['f1', 'd1'])
  })

  it('resolved 为空时全部事件都是 ACTIVE', () => {
    const entries = toRunCardEntries([gate, failure], [])
    expect(entries.every((e) => e.event && !e.frozen)).toBe(true)
  })
})
