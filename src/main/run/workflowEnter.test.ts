import { describe, it, expect } from 'vitest'
import { planToStageViews, buildWorkflowSession, tailLaunchConfig } from './workflowEnter'
import type { RunPlan } from './machine'

const plan: RunPlan = {
  runId: 'r1',
  stages: [
    { key: 'requirement', name: '需求评估', provider: 'claude', model: 'opus', scope: 'root', gate: false, prompt: '梳理需求' },
    { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: true, prompt: '出方案', permissionMode: 'readonly' },
    { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt', scope: 'per-project', gate: false, prompt: '写代码' },
  ],
}

describe('planToStageViews', () => {
  it('maps each StagePlan to a stage view carrying provider/model/permission/scope/preamble', () => {
    const views = planToStageViews(plan)
    expect(views).toHaveLength(3)
    expect(views[1]).toMatchObject({ key: 'design', provider: 'claude', model: 'opus', scope: 'root', permissionMode: 'readonly', preamble: '出方案' })
    expect(views[2]).toMatchObject({ key: 'develop', scope: 'per-project', preamble: '写代码' })
  })
})

describe('buildWorkflowSession', () => {
  it('starts at index 0 in chatting when the first stage is conversational (root)', () => {
    const ws = buildWorkflowSession({ flowId: 'wf1', flowName: '标准', plan, projects: [{ name: 'api', provider: 'codex', model: 'gpt' }], seed: 's', supplement: 'x' })
    expect(ws.currentIndex).toBe(0)
    expect(ws.phase).toBe('chatting')
    expect(ws.flowId).toBe('wf1')
    expect(ws.projects[0].name).toBe('api')
    expect(ws.seed).toBe('s')
  })
  it('starts in executing when the first stage is fan-out (per-project)', () => {
    const p: RunPlan = { runId: 'r', stages: [{ key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: false }] }
    const ws = buildWorkflowSession({ flowId: 'wf', flowName: 'f', plan: p, projects: [] })
    expect(ws.phase).toBe('executing')
  })
})

describe('tailLaunchConfig', () => {
  it('enables only stages from fromIndex and restores each stage scope via perProject', () => {
    const views = planToStageViews(plan)
    const cfg = tailLaunchConfig(
      { workspacePath: '/ws', flowId: 'wf1', sessionId: 'sess', seed: 's', supplement: 'x', projects: [{ name: 'api', provider: 'codex', model: 'gpt', permissionMode: 'full' }] },
      views, 2,
    )
    expect(cfg.workflowId).toBe('wf1')
    expect(cfg.sessionId).toBe('sess')
    expect(cfg.projects[0].permissionMode).toBe('full')
    // only develop (index 2) enabled
    expect(cfg.stages!.map((s) => [s.key, s.enabled])).toEqual([['requirement', false], ['design', false], ['develop', true]])
    // scope restored: root stages → perProject false, fan-out → true
    expect(cfg.stages!.map((s) => s.perProject)).toEqual([false, false, true])
    // per-stage permission carried
    expect(cfg.stages!.find((s) => s.key === 'design')!.permissionMode).toBe('readonly')
  })
})
