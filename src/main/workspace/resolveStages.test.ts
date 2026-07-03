import { describe, it, expect } from 'vitest'
import { resolveStages } from './resolveStages'
import type { Workspace, Workflow } from '../config/schema'

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

  it('(d) defaults a review stage WITHOUT review config to parallel/per-project', () => {
    const stages = [{ key: 'review' as const, provider: 'claude', model: 'opus-4.8' }]
    const result = resolveStages({ workflowId: 'standard', stages }, [wf])
    expect(result[0].review).toEqual({ mode: 'parallel', scope: 'per-project' })
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
