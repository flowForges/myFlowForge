import { describe, it, expect } from 'vitest'
import { buildPluginPrompt, INTERACTION_DIRECTIVE } from './brief'

describe('buildPluginPrompt', () => {
  it('prepends skill directive and includes upstream briefs + plugin prompt', () => {
    const p = { id: 'p', name: '读取记忆', prompt: '整理我的偏好', after: 'requirement', skills: ['analyze'], tools: ['read'] }
    const out = buildPluginPrompt(p as any, [{ agentName: '需求分析', summary: '已产出需求', artifacts: [] }], '做个登录页')
    expect(out).toContain('analyze')            // skill directive
    expect(out).toContain('已产出需求')          // upstream brief
    expect(out).toContain('整理我的偏好')        // plugin prompt
  })
  it('no skills → no directive noise', () => {
    const p = { id: 'p', name: 'x', prompt: 'do', after: '__start', skills: [], tools: [] }
    expect(buildPluginPrompt(p as any, [], undefined)).toContain('do')
  })
})

describe('interaction directive in plugin prompt', () => {
  it('buildPluginPrompt 注入 forge_ask 交互铁律', () => {
    const plugin = { id: 'p1', name: '确认闸', prompt: '检查后放行', after: '__wf', skills: [], tools: [] }
    const out = buildPluginPrompt(plugin as any, [], undefined)
    expect(out).toContain('【交互指令】')
    expect(out).toContain('forge_ask')
  })
})
