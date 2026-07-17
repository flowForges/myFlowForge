import { describe, it, expect } from 'vitest'
import { applyGateDecision } from './decisions'
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
