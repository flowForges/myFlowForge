import { describe, it, expect } from 'vitest'
import { forgeChatDirective } from './forgeChatDirective'

describe('forgeChatDirective', () => {
  it('is empty (fail-open) when the propose tool is not exposed', () => {
    expect(forgeChatDirective({})).toBe('')
    expect(forgeChatDirective({ FORGE_TOOLS: 'forge_read_context,forge_handoff' })).toBe('')
  })

  it('inlines the propose guidance when forge_propose_plan is exposed', () => {
    const d = forgeChatDirective({ FORGE_TOOLS: 'forge_read_context,forge_propose_plan' })
    expect(d).not.toBe('')
    expect(d).toContain('forge_propose_plan')
  })

  it('is conservative: reading/understanding code + questions must NOT propose', () => {
    const d = forgeChatDirective({ FORGE_TOOLS: 'forge_propose_plan' })
    // Default DON'T-propose case, explicit and prominent.
    expect(d).toContain('阅读、理解、解释、分析现有代码')
    expect(d).toContain('绝不调用')
    // Only an explicit build/change request triggers a proposal.
    expect(d).toContain('明确要求')
    // Ambiguous → ask first, never auto-propose.
    expect(d).toContain('拿不准')
  })

  it('FORGE_WORKFLOWS 存在时把工作流清单拼进 directive', () => {
    const d = forgeChatDirective({
      FORGE_TOOLS: 'forge_propose_plan',
      FORGE_WORKFLOWS: JSON.stringify([{ id: 'full', name: '完整', stages: [{ key: 'requirement' }, { key: 'develop' }] }]),
    })
    expect(d).toContain('完整')
    expect(d).toContain('`full`')
    expect(d).toContain('workflowId')
  })

  // FIX 6c: non-claude agents (via FORGE_WORKFLOWS JSON) must see the SAME stage label as claude
  // (via forgeWorkflowSkill.ts's workflowListSection, which calls stageName(key, s.name)) — a
  // custom stage's display name must flow through, not just its key.
  it('a custom stage name in FORGE_WORKFLOWS is rendered, not the raw key', () => {
    const d = forgeChatDirective({
      FORGE_TOOLS: 'forge_propose_plan',
      FORGE_WORKFLOWS: JSON.stringify([{ id: 'full', name: '完整', stages: [{ key: 'custom-1', name: '自定义验收' } ] }]),
    })
    expect(d).toContain('自定义验收')
    expect(d).not.toContain('custom-1 →')
  })

  it('FORGE_WORKFLOWS 缺失或非法 JSON 时不追加清单、也不报错', () => {
    const noEnv = forgeChatDirective({ FORGE_TOOLS: 'forge_propose_plan' })
    expect(noEnv).not.toContain('本工作区可选工作流')
    const badJson = forgeChatDirective({ FORGE_TOOLS: 'forge_propose_plan', FORGE_WORKFLOWS: '{not json' })
    expect(badJson).not.toContain('本工作区可选工作流')
  })
})
