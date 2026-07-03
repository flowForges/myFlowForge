import { describe, it, expect } from 'vitest'
import { buildWorkflow } from './buildWorkflow'

describe('buildWorkflow', () => {
  it('builds a workflow with picked stages in canonical order + claude/opus-4.8 defaults', () => {
    const wf = buildWorkflow('Refactor Flow', ['test', 'develop'], [])
    expect(wf.id).toBe('refactor-flow')
    expect(wf.name).toBe('Refactor Flow')
    expect(wf.stages.map(s => s.key)).toEqual(['develop', 'test'])
    expect(wf.stages[0]).toEqual({ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' })
  })
  it('dedupes the id against existing ids by suffixing', () => {
    const wf = buildWorkflow('Standard', ['develop'], ['standard'])
    expect(wf.id).toBe('standard-2')
    const wf2 = buildWorkflow('Standard', ['develop'], ['standard', 'standard-2'])
    expect(wf2.id).toBe('standard-3')
  })
})
