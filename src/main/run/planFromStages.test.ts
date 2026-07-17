import { describe, it, expect } from 'vitest'
import { planFromStages } from './planFromStages'
import type { StageSpec } from '../orchestrator/orchestrator'

const stages: StageSpec[] = [
  { key: 'requirement', name: '需求', provider: 'claude', model: 'm' },
  { key: 'design', name: '方案', provider: 'claude', model: 'm', gate: true },
  { key: 'develop', name: '开发', provider: 'codex', model: 'g' },
  { key: 'review', name: 'CR', provider: 'codex', model: 'g', scope: 'root', gate: false },
]

describe('planFromStages', () => {
  it('maps stages to a RunPlan with scope/gate defaults', () => {
    const plan = planFromStages('run-1', stages)
    expect(plan.runId).toBe('run-1')
    expect(plan.stages.map((s) => s.key)).toEqual(['requirement', 'design', 'develop', 'review'])
    // requirement: no scope → default 'root'; no gate → false
    expect(plan.stages[0]).toMatchObject({ scope: 'root', gate: false, provider: 'claude', model: 'm' })
    // design: DEFAULT_STAGE_SCOPE.design = per-project; gate explicitly true
    expect(plan.stages[1]).toMatchObject({ scope: 'per-project', gate: true })
    // develop: DEFAULT_STAGE_SCOPE.develop = per-project
    expect(plan.stages[2]).toMatchObject({ scope: 'per-project', provider: 'codex', model: 'g' })
    // review: explicit scope root, gate false
    expect(plan.stages[3]).toMatchObject({ scope: 'root', gate: false })
  })
})
