import { describe, it, expect } from 'vitest'
import { initMachine, stageIndex, currentStage, type RunPlan } from './machine'

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
