import { describe, it, expect } from 'vitest'
import { planFromStages } from './planFromStages'
import type { StageSpec } from '../run/runTypes'

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

  it('design gates by DEFAULT when no explicit gate is set; a non-design stage does not (方案门 fix)', () => {
    const plan = planFromStages('run-g', [
      { key: 'design', name: '方案', provider: 'claude', model: 'm' },      // no explicit gate
      { key: 'requirement', name: '需求', provider: 'claude', model: 'm' }, // no explicit gate
    ])
    expect(plan.stages[0]).toMatchObject({ key: 'design', gate: true })   // default-gated
    expect(plan.stages[1]).toMatchObject({ key: 'requirement', gate: false })
  })

  it('an explicit gate:false on design still wins over the default', () => {
    const plan = planFromStages('run-g2', [{ key: 'design', name: '方案', provider: 'claude', model: 'm', gate: false }])
    expect(plan.stages[0].gate).toBe(false)
  })

  it('③hooks: attaches hooks when passed, omits the field entirely when none', () => {
    const noHooks = planFromStages('run-h0', [{ key: 'design', name: '方案', provider: 'claude', model: 'm' }])
    expect('hooks' in noHooks).toBe(false)
    const withHooks = planFromStages('run-h1', [{ key: 'design', name: '方案', provider: 'claude', model: 'm' }],
      [{ id: 'a', name: 'H', prompt: 'x', after: '__start', skills: [], tools: [] }])
    expect(withHooks.hooks?.map(h => h.id)).toEqual(['a'])
  })

  it('resolves a built-in stage prompt from STAGE_PROMPTS when no custom prompt is set', () => {
    const plan = planFromStages('run-2', [{ key: 'design', name: '方案', provider: 'claude', model: 'm' }])
    expect(plan.stages[0].prompt).toBeTruthy()
    expect(plan.stages[0].prompt).toContain('方案')
  })

  it('appends a custom prompt after the built-in base prompt for a built-in stage', () => {
    const plan = planFromStages('run-3', [{ key: 'design', name: '方案', provider: 'claude', model: 'm', prompt: '额外要求:只改前端' }])
    expect(plan.stages[0].prompt).toContain('方案') // base still present
    expect(plan.stages[0].prompt).toContain('额外要求:只改前端') // custom appended
  })

  it('uses the custom prompt verbatim as the full prompt for a custom (non-built-in) stage', () => {
    const plan = planFromStages('run-4', [{ key: 'x', name: '自定义', provider: 'claude', model: 'm', prompt: '做X' }])
    expect(plan.stages[0].prompt).toBe('做X')
  })

  it('leaves prompt undefined for a custom stage with no prompt set', () => {
    const plan = planFromStages('run-5', [{ key: 'y', name: '自定义', provider: 'claude', model: 'm' }])
    expect(plan.stages[0].prompt).toBeUndefined()
  })

  it('a producesDoc stage gets an explicit forge_write_artifact instruction', () => {
    const plan = planFromStages('r1', [
      { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', producesDoc: true },
    ] as any)
    expect(plan.stages[0].prompt).toContain('forge_write_artifact')
    expect(plan.stages[0].prompt).toMatch(/design-.*\.md|技术方案/)
    expect(plan.stages[0].producesDoc).toBe(true)
  })
})
