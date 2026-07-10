import { describe, it, expect } from 'vitest'
import { indexCustomStages, resolveStageDef, resolveStages, type CustomStageDef, type StageRef } from './customStages'

const secAudit: CustomStageDef = {
  id: 'lib-1', key: 'lib-1', name: '安全审计',
  defaultAgent: 'codex', defaultModel: 'gpt-5-codex', prompt: '审查安全风险', gate: true, scope: 'root',
}
const byId = indexCustomStages([secAudit])

describe('customStages resolver', () => {
  it('resolves a libId reference to the shared definition, keeping the template key + libId', () => {
    const ref: StageRef = { key: 'custom-1', libId: 'lib-1', name: '旧缓存名', defaultAgent: 'claude', defaultModel: '' }
    const out = resolveStageDef(ref, byId)
    expect(out.key).toBe('custom-1')          // template key preserved (order + identity)
    expect(out.libId).toBe('lib-1')
    expect(out.name).toBe('安全审计')          // shared def wins over the cached name
    expect(out.defaultAgent).toBe('codex')
    expect(out.defaultModel).toBe('gpt-5-codex')
    expect(out.prompt).toBe('审查安全风险')
    expect(out.gate).toBe(true)
    expect((out as { id?: string }).id).toBeUndefined()   // the def's id is not leaked onto the stage
  })

  it('returns a stage without libId unchanged (built-in / inline custom — back-compat)', () => {
    const builtin = { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }
    expect(resolveStageDef(builtin, byId)).toBe(builtin)
    const inline = { key: 'custom-2', name: '内嵌阶段', defaultAgent: 'claude', defaultModel: '' }
    expect(resolveStageDef(inline, byId)).toBe(inline)
  })

  it('returns a DANGLING reference (lib def deleted) unchanged, using its cached fields — no throw', () => {
    const dangling = { key: 'custom-3', libId: 'gone', name: '缓存名', defaultAgent: 'claude', defaultModel: 'm' }
    const out = resolveStageDef(dangling, {})
    expect(out).toBe(dangling)
    expect(out.name).toBe('缓存名')
  })

  it('resolveStages resolves a whole list, preserving order', () => {
    const stages = [
      { key: 'requirement', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
      { key: 'custom-1', libId: 'lib-1', name: 'x', defaultAgent: 'claude', defaultModel: '' },
      { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
    ]
    const out = resolveStages(stages, byId)
    expect(out.map(s => s.key)).toEqual(['requirement', 'custom-1', 'develop'])
    expect(out[1].name).toBe('安全审计')
  })
})
