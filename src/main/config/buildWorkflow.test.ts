import { describe, it, expect } from 'vitest'
import { buildWorkflow } from './buildWorkflow'

describe('buildWorkflow', () => {
  it('builds a workflow preserving the given stage order + claude/opus-4.8 defaults', () => {
    const wf = buildWorkflow('Refactor Flow', ['test', 'develop'], [])
    expect(wf.id).toBe('refactor-flow')
    expect(wf.name).toBe('Refactor Flow')
    expect(wf.stages.map(s => s.key)).toEqual(['test', 'develop'])   // order preserved as given
    expect(wf.stages[0]).toEqual({ key: 'test', defaultAgent: 'claude', defaultModel: 'opus-4.8' })
  })
  it('accepts full custom stage configs alongside bare keys, deduping by key', () => {
    const wf = buildWorkflow('Mix', ['requirement', { key: 'security-audit', name: '安全审计', defaultAgent: 'claude', defaultModel: 'm', gate: true }, 'requirement'], [])
    expect(wf.stages.map(s => s.key)).toEqual(['requirement', 'security-audit'])   // deduped
    expect(wf.stages[1]).toMatchObject({ key: 'security-audit', name: '安全审计', gate: true })
  })
  it('dedupes the id against existing ids by suffixing', () => {
    const wf = buildWorkflow('Standard', ['develop'], ['standard'])
    expect(wf.id).toBe('standard-2')
    const wf2 = buildWorkflow('Standard', ['develop'], ['standard', 'standard-2'])
    expect(wf2.id).toBe('standard-3')
  })
})
