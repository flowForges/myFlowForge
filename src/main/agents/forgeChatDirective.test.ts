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

  it('routes single actions to forge_delegate and multi-stage requests to forge_propose_plan', () => {
    const d = forgeChatDirective({ FORGE_TOOLS: 'forge_propose_plan,forge_delegate' })
    // Pure conversation is answered directly.
    expect(d).toContain('纯对话')
    // Single action → lightweight delegation.
    expect(d).toContain('forge_delegate')
    expect(d).toContain('单一动作')
    // Multi-stage → propose (opens the workflow gate).
    expect(d).toContain('forge_propose_plan')
    // Main agent never reads/writes itself, never uses the CLI's built-in Task/subagent.
    expect(d).toContain('Task/subagent')
    // Conservative routing: ambiguous → ask first.
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
