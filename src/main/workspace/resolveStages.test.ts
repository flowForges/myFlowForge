import { describe, it, expect } from 'vitest'
import { resolveStages, pickWorkspaceWorkflow, resolveWorkflowStages, unionWorkflowStages } from './resolveStages'
import type { Workspace, Workflow, WsWorkflow } from '../config/schema'

const wf: Workflow = {
  id: 'standard',
  name: '标准工作流',
  stages: [
    { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
    { key: 'develop', defaultAgent: 'codex', defaultModel: 'gpt-5-codex' },
  ],
  plugins: [], stagePrompts: {},
}

const wsBase: Pick<Workspace, 'stages' | 'workflowId'> = {
  workflowId: 'standard',
  stages: [],
}

describe('resolveStages', () => {
  it('(a) returns ws.stages as-is when non-empty (persisted stages win)', () => {
    const existing = [{ key: 'develop' as const, provider: 'claude', model: 'sonnet-4.6' }]
    const result = resolveStages({ ...wsBase, stages: existing }, [wf])
    expect(result).toEqual(existing)
  })

  it('(b) maps defaultAgent/defaultModel from workflow when ws.stages is empty + workflow matches', () => {
    const result = resolveStages({ workflowId: 'standard', stages: [] }, [wf])
    expect(result).toEqual([
      { key: 'design', provider: 'claude', model: 'opus-4.8' },
      { key: 'develop', provider: 'codex', model: 'gpt-5-codex' },
    ])
  })

  it('(c) returns [] when ws.stages empty and no matching workflow found', () => {
    const result = resolveStages({ workflowId: 'nonexistent', stages: [] }, [wf])
    expect(result).toEqual([])
  })

  it('(d) defaults a review stage WITHOUT review config to 并行多视角 (all four lenses — ②多镜头CR)', () => {
    const stages = [{ key: 'review' as const, provider: 'claude', model: 'opus-4.8' }]
    const result = resolveStages({ workflowId: 'standard', stages }, [wf])
    expect(result[0].review).toEqual({ mode: 'parallel', reviewers: ['correctness', 'security', 'performance', 'style'] })
  })

  it('(e) keeps an explicit review config (single / multi-lens) intact', () => {
    const single = resolveStages(
      { workflowId: 'standard', stages: [{ key: 'review' as const, provider: 'claude', model: 'm', review: { mode: 'single' } }] },
      [wf],
    )
    expect(single[0].review).toEqual({ mode: 'single' })
    const lens = resolveStages(
      { workflowId: 'standard', stages: [{ key: 'review' as const, provider: 'claude', model: 'm', review: { mode: 'parallel', scope: 'workspace', reviewers: ['security'] } }] },
      [wf],
    )
    expect(lens[0].review).toEqual({ mode: 'parallel', scope: 'workspace', reviewers: ['security'] })
  })

  it('(f) does NOT add a review config to non-review stages', () => {
    const result = resolveStages({ workflowId: 'standard', stages: [{ key: 'develop' as const, provider: 'claude', model: 'm' }] }, [wf])
    expect(result[0].review).toBeUndefined()
  })

  it('旧工作区(空 stages)从模板 stagePrompts 物化追加段', () => {
    const ws: any = { stages: [], workflowId: 'wf1' }
    const workflows: any = [{ id: 'wf1', name: 'WF', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], plugins: [], stagePrompts: { design: '画时序图' } }]
    const out = resolveStages(ws, workflows)
    expect(out.find(s => s.key === 'design')?.prompt).toBe('画时序图')
  })
})

const multiWs = (): Workspace => ({
  name: 'w', path: '/w', workflowId: '', stages: [], projects: [],
  status: 'idle', plugins: [], stepPlugins: [],
  workflows: [
    { id: 'light', name: '轻量', stages: [
      { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
      { key: 'design', provider: 'claude', model: 'opus-4.8' },
    ] },
    { id: 'full', name: '完整', stages: [
      { key: 'requirement', provider: 'codex', model: 'gpt-5' },
      { key: 'develop', provider: 'codex', model: 'gpt-5' },
      { key: 'review', provider: 'claude', model: 'opus-4.8' },
    ] },
  ],
})

describe('pickWorkspaceWorkflow', () => {
  it('按 id 命中', () => { expect(pickWorkspaceWorkflow(multiWs(), 'full')?.name).toBe('完整') })
  it('无 id → 第一条(默认)', () => { expect(pickWorkspaceWorkflow(multiWs())?.id).toBe('light') })
  it('id 对不上 → 第一条兜底', () => { expect(pickWorkspaceWorkflow(multiWs(), 'nope')?.id).toBe('light') })
})

describe('resolveWorkflowStages', () => {
  it('固化阶段直接用', () => {
    const stages = resolveWorkflowStages(pickWorkspaceWorkflow(multiWs(), 'full')!, [])
    expect(stages.map(s => s.key)).toEqual(['requirement', 'develop', 'review'])
    expect(stages[0].provider).toBe('codex')
  })

  // Repro for the run2 launcher bug: a workspace workflow with EMPTY stashed stages whose `id` does
  // NOT match any current global template (e.g. the template was recreated/migrated under a new id)
  // still resolves via a secondary by-NAME fallback, so the launcher preview and the actual run
  // (resolveStartPlan, which calls this same function) both see the real stage list instead of
  // silently falling back to [] just because the id drifted.
  it('id 对不上时按显示名兜底全局模板(id 是旧值/生成值,但名字仍对得上某个全局模板)', () => {
    const wsWorkflow: WsWorkflow = { id: 'generated-abc123', name: '标准工作流', stages: [] }
    const globalWorkflows: Workflow[] = [wf, { id: 'other', name: '别的流程', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'x' }], plugins: [], stagePrompts: {} }]
    // `wf` above (module-level const) is id:'standard' name:'标准工作流' — id doesn't match
    // wsWorkflow.id ('generated-abc123') but its name does.
    const stages = resolveWorkflowStages(wsWorkflow, globalWorkflows)
    expect(stages.map(s => s.key)).toEqual(['design', 'develop'])
    expect(stages[0]).toEqual({ key: 'design', provider: 'claude', model: 'opus-4.8' })
  })

  it('id 和名字都对不上 → 仍返回 []', () => {
    const wsWorkflow: WsWorkflow = { id: 'generated-abc123', name: '不存在的流程', stages: [] }
    const stages = resolveWorkflowStages(wsWorkflow, [wf])
    expect(stages).toEqual([])
  })
})

describe('unionWorkflowStages', () => {
  it('跨工作流按 key 去重,首条优先', () => {
    const stages = unionWorkflowStages(multiWs(), [])
    expect(stages.map(s => s.key)).toEqual(['requirement', 'design', 'develop', 'review'])
    // requirement 在 light 里先出现 → 用 light 的 provider
    expect(stages.find(s => s.key === 'requirement')?.provider).toBe('claude')
  })
})
