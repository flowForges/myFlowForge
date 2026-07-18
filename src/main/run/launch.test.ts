import { describe, it, expect } from 'vitest'
import { buildLaunchInfo, resolveStartPlan } from './launch'
import type { Workspace } from '../config/schema'

const ws: Workspace = {
  name: 'pay', path: '/ws/pay', workflowId: '', stages: [],
  workflows: [{ id: 'wf1', name: '标准五段', stages: [
    { key: 'design', provider: 'claude', model: 'm', scope: 'root', gate: true, prompt: '额外要求:只改前端' },
    { key: 'develop', provider: 'codex', model: 'g' },
  ] }],
  projects: [{ repoId: 'api', name: 'api', branch: 'main', provider: 'codex', model: 'g' }, { repoId: 'web', name: 'web', branch: 'main' }] as any,
  status: 'idle', plugins: [], stepPlugins: [],
} as any

describe('buildLaunchInfo', () => {
  it('lists workflows + projects with cwd', () => {
    const info = buildLaunchInfo(ws)
    expect(info.workflows).toEqual([{ id: 'wf1', name: '标准五段' }])
    expect(info.projects.map((p) => p.name)).toEqual(['api', 'web'])
    expect(info.projects[0].cwd).toBe('/ws/pay/api')
    expect(info.projects[0].provider).toBe('codex')
  })
})

describe('resolveStartPlan', () => {
  it('resolves the picked workflow stages into a RunPlan + filtered projects', () => {
    const { plan, projects, task } = resolveStartPlan(ws, [], [], { workspacePath: '/ws/pay', workflowId: 'wf1', projectNames: ['api'], task: '做幂等', runId: 'r1' })
    expect(plan.stages.map((s) => s.key)).toEqual(['design', 'develop'])
    expect(plan.stages[0].gate).toBe(true)
    // custom per-stage prompt (WsStage.prompt) must survive resolveStartPlan → planFromStages,
    // appended after the built-in design base prompt.
    expect(plan.stages[0].prompt).toContain('技术方案')
    expect(plan.stages[0].prompt).toContain('额外要求:只改前端')
    expect(projects.map((p) => p.name)).toEqual(['api']) // filtered
    expect(task).toBe('做幂等')
  })
  it('throws on unknown workflow', () => {
    expect(() => resolveStartPlan(ws, [], [], { workspacePath: '/ws/pay', workflowId: 'nope', projectNames: [], runId: 'r1' })).toThrow()
  })
})
