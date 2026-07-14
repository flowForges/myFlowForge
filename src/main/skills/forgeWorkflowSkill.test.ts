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

  it('gates workflow via forge_propose_plan (path two) and routes single actions to forge_delegate (path one)', () => {
    const c = FORGE_WORKFLOW_SKILL.content
    expect(c.startsWith('---\n')).toBe(true)
    expect(c).toContain('name: forge-workflow')
    expect(c).toContain('description:')
    expect(c).toContain('forge_propose_plan')    // path two: opens the workflow gate
    expect(c).toContain('forge_delegate')        // path one: lightweight delegation
    // Must instruct not to execute before approval
    expect(c).toContain('批准前不要执行')
  })

  it('pure conversation answers directly; single actions delegate, multi-stage proposes', () => {
    const c = FORGE_WORKFLOW_SKILL.content
    // Pure conversation (concepts / discussion / refining a text plan) is answered directly.
    expect(c).toContain('纯对话')
    // A single action goes through forge_delegate — never the main agent itself, never a built-in Task.
    expect(c).toContain('forge_delegate')
    expect(c).toContain('Task/subagent')
    // Routing is by whether the request spans stages, and is conservative when unsure.
    expect(c).toContain('是否跨阶段')
    expect(c).toContain('拿不准')
  })

  it('self-excludes for orchestrated stage sub-agents (scope note near the top)', () => {
    const c = FORGE_WORKFLOW_SKILL.content
    expect(c).toContain('适用范围')
    expect(c).toContain('不要使用本技能')
    // References the stage-task markers a stage sub-agent would see.
    expect(c).toContain('当前阶段')
    expect(c).toContain('执行指令')
    // The scope note must appear before the path-one body so it gates early.
    expect(c.indexOf('适用范围')).toBeLessThan(c.indexOf('路径一'))
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
