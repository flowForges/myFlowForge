import { describe, it, expect } from 'vitest'
import { applyGateDecision, type LaneDecision } from './decisions'
import { initMachine, markRunning, advance, type RunPlan } from './machine'

const plan: RunPlan = {
  runId: 'r', stages: [
    { key: 'requirement', name: '需求', provider: 'c', model: 'm', scope: 'root', gate: false },
    { key: 'design', name: '方案', provider: 'c', model: 'm', scope: 'root', gate: true },
    { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: true },
  ],
}

describe('applyGateDecision', () => {
  it('advance moves current stage to done and index forward', () => {
    const s = markRunning(initMachine(plan))
    const n = applyGateDecision(s, { type: 'advance' })
    expect(n.stages[0].status).toBe('done')
    expect(n.currentIndex).toBe(1)
  })
  it('redo bumps round and keeps index', () => {
    const s = markRunning(initMachine(plan))
    const n = applyGateDecision(s, { type: 'redo', feedback: 'add idempotency' })
    expect(n.stages[0].round).toBe(1)
    expect(n.stages[0].status).toBe('running')
    expect(n.currentIndex).toBe(0)
  })
  it('jumpBack rewinds to target, marks downstream done stages stale', () => {
    let s = initMachine(plan)
    s = advance(advance(s)) // req done, design done, at develop
    const n = applyGateDecision(s, { type: 'jumpBack', targetKey: 'requirement' })
    expect(n.currentIndex).toBe(0)
    expect(n.stages[0].status).toBe('running')
    expect(n.stages[1].status).toBe('stale')
  })
})

// P3-3: a "doubt" (方案存疑) event is resolved via one of four LaneDecision actions —
// dismiss (驳回继续)/redo (补充说明后继续)/jumpBack (回退改方案)/abort (终止运行, already existed).
// dismiss has no machine transform of its own (the controller just drops the event and lets the
// stage proceed normally) — these are compile-time + shape checks that the union carries it and
// reuses GateDecision's redo/jumpBack shapes (targetKey optional: the doubt UI is a single button
// with no stage picker, so the controller defaults it to the design stage when omitted).
describe('LaneDecision doubt-resolution variants', () => {
  it('dismiss is a valid LaneDecision', () => {
    const d: LaneDecision = { type: 'dismiss' }
    expect(d.type).toBe('dismiss')
  })
  it('redo/jumpBack are valid LaneDecisions, reusing GateDecision-shaped fields', () => {
    const redo: LaneDecision = { type: 'redo', feedback: '补充说明' }
    const jumpBackExplicit: LaneDecision = { type: 'jumpBack', targetKey: 'design', feedback: '回退理由' }
    const jumpBackDefault: LaneDecision = { type: 'jumpBack' } // targetKey omitted on purpose
    expect(redo).toEqual({ type: 'redo', feedback: '补充说明' })
    expect(jumpBackExplicit.type).toBe('jumpBack')
    expect(jumpBackDefault).toEqual({ type: 'jumpBack' })
  })
})
