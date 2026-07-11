import { describe, it, expect } from 'vitest'
import { FORGE_WORKFLOW_SKILL, workflowListSection } from './forgeWorkflowSkill'
import type { Workspace } from '../config/schema'

const wsWith2Workflows: Workspace = {
  name: 'demo', path: '/tmp/demo', workflowId: '', stages: [],
  workflows: [
    { id: 'light', name: '轻量', stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }] },
    { id: 'full', name: '完整', stages: [
      { key: 'requirement', provider: 'claude', model: 'sonnet' },
      { key: 'develop', provider: 'claude', model: 'sonnet' },
    ] },
  ],
  projects: [], status: 'idle', plugins: [], stepPlugins: [],
}

describe('FORGE_WORKFLOW_SKILL', () => {
  it('installs under .claude/skills and is named forge-workflow', () => {
    expect(FORGE_WORKFLOW_SKILL.name).toBe('forge-workflow')
    expect(FORGE_WORKFLOW_SKILL.relPath).toBe('.claude/skills/forge-workflow/SKILL.md')
  })

  it('gates activation to dev intents, calls forge_propose_plan (primary), keeps forge:run fence (fallback)', () => {
    const c = FORGE_WORKFLOW_SKILL.content
    expect(c.startsWith('---\n')).toBe(true)
    expect(c).toContain('name: forge-workflow')
    expect(c).toContain('description:')
    expect(c).toContain('forge_propose_plan')    // primary: propose for approval
    expect(c).toContain('```forge:run')          // fallback: text fence
    expect(c).toContain('"task"')
    // Must instruct not to execute before approval
    expect(c).toContain('批准前不要执行')
  })

  it('is conservative: reading/understanding existing code and questions must NOT propose', () => {
    const c = FORGE_WORKFLOW_SKILL.content
    // Default is DON'T propose: reading/understanding/explaining existing code + any question just gets answered.
    expect(c).toContain('阅读、理解、解释、分析现有代码')
    expect(c).toContain('绝不调用')
    // Only an explicit build/change request triggers a proposal.
    expect(c).toContain('明确要求')
    // Ambiguous intent → ask one line first, never auto-propose.
    expect(c).toContain('拿不准')
    // The "don't propose" guidance must appear before the propose flow so it gates first.
    expect(c.indexOf('绝不调用')).toBeLessThan(c.indexOf('forge_propose_plan({approach,'))
  })

  it('self-excludes for orchestrated stage sub-agents (scope note near the top)', () => {
    const c = FORGE_WORKFLOW_SKILL.content
    expect(c).toContain('适用范围')
    expect(c).toContain('不要使用本技能')
    // References the stage-task markers a stage sub-agent would see.
    expect(c).toContain('当前阶段')
    expect(c).toContain('执行指令')
    // The scope note must appear before the "标准流程" body so it gates early.
    expect(c.indexOf('适用范围')).toBeLessThan(c.indexOf('标准流程'))
  })
})

describe('workflowListSection', () => {
  it('列出工作流名+阶段序列', () => {
    const md = workflowListSection(wsWith2Workflows)
    expect(md).toContain('轻量')
    expect(md).toContain('完整')
    expect(md).toContain('workflowId')   // 指导里提到把 id 传给 workflowId
  })

  it('包含每条工作流的 id 与阶段显示名序列', () => {
    const md = workflowListSection(wsWith2Workflows)
    expect(md).toContain('`light`')
    expect(md).toContain('`full`')
    expect(md).toContain('需求')   // requirement 阶段的内置显示名
    expect(md).toContain('开发')   // develop 阶段的内置显示名
  })
})
