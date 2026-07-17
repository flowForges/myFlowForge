import { describe, it, expect } from 'vitest'
import { initMachine, stageIndex, currentStage, type RunPlan } from './machine'
import { markRunning, advance, redo, jumpBack } from './machine'

const plan: RunPlan = {
  runId: 'r1',
  stages: [
    { key: 'requirement', name: '需求评审', provider: 'c', model: 'm', scope: 'root', gate: false },
    { key: 'design', name: '方案', provider: 'c', model: 'm', scope: 'root', gate: true },
    { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: true },
  ],
}

describe('initMachine', () => {
  it('initializes all stages pending at index 0', () => {
    const s = initMachine(plan)
    expect(s.currentIndex).toBe(0)
    expect(s.stages.map((x) => x.status)).toEqual(['pending', 'pending', 'pending'])
    expect(s.stages.every((x) => x.round === 0)).toBe(true)
  })
  it('stageIndex + currentStage helpers', () => {
    const s = initMachine(plan)
    expect(stageIndex(s, 'develop')).toBe(2)
    expect(stageIndex(s, 'nope')).toBe(-1)
    expect(currentStage(s)?.key).toBe('requirement')
  })
})

describe('transitions', () => {
  it('advance marks current done and moves to next', () => {
    let s = initMachine(plan)
    s = advance(s)
    expect(s.stages[0].status).toBe('done')
    expect(s.currentIndex).toBe(1)
    expect(currentStage(s)?.key).toBe('design')
  })

  it('advancing past the last stage leaves all done', () => {
    let s = initMachine(plan)
    s = advance(advance(advance(s)))
    expect(s.stages.map((x) => x.status)).toEqual(['done', 'done', 'done'])
    expect(s.currentIndex).toBe(2) // clamped at last
  })

  it('redo bumps round and sets running', () => {
    let s = markRunning(initMachine(plan))
    s = redo(s)
    expect(s.stages[0].round).toBe(1)
    expect(s.stages[0].status).toBe('running')
  })

  it('jumpBack marks downstream done stages stale and reactivates target', () => {
    let s = initMachine(plan)
    s = advance(advance(s)) // requirement done, design done, now at develop
    expect(s.stages.map((x) => x.status)).toEqual(['done', 'done', 'pending'])
    s = jumpBack(s, 'requirement')
    expect(s.currentIndex).toBe(0)
    expect(s.stages[0].status).toBe('running')
    expect(s.stages[0].round).toBe(1)
    expect(s.stages[1].status).toBe('stale') // design was done -> stale
    expect(s.stages[2].status).toBe('pending') // develop was pending -> untouched
  })

  it('markRunning revives a stale stage', () => {
    let s = initMachine(plan)
    s = advance(advance(s))
    s = jumpBack(s, 'requirement')
    s = advance(s) // requirement done -> move to design (stale)
    expect(currentStage(s)?.status).toBe('stale')
    s = markRunning(s)
    expect(currentStage(s)?.status).toBe('running')
  })

  it('does not mutate the input state', () => {
    const s0 = initMachine(plan)
    const s1 = advance(s0)
    expect(s0.stages[0].status).toBe('pending')
    expect(s1).not.toBe(s0)
  })
})
