import { describe, it, expect } from 'vitest'
import { toWorkflowProgressState } from './workflowProgressAdapter'
import { buildStageRuntimes } from './runExecAdapter'
import type { WorkflowSessionState } from '@shared/workflowSession'

function wf(partial: Partial<WorkflowSessionState>): WorkflowSessionState {
  return {
    flowId: 'f1',
    flowName: '标准流程',
    stages: [
      { key: 'req', name: '需求评审', provider: 'claude', model: 'opus', scope: 'root' },
      { key: 'design', name: '技术方案', provider: 'codex', model: 'gpt', scope: 'root' },
      { key: 'dev', name: '开发', provider: 'claude', model: 'opus', scope: 'per-project' },
    ],
    currentIndex: 0,
    phase: 'chatting',
    projects: [{ name: 'app', provider: 'claude', model: 'opus' }],
    ...partial,
  }
}

describe('toWorkflowProgressState', () => {
  it('maps stages → plan with honest per-stage status from currentIndex', () => {
    const st = toWorkflowProgressState(wf({ currentIndex: 1 }), '/ws')
    expect(st.machine.stages.map((s) => s.status)).toEqual(['done', 'running', 'pending'])
    expect(st.machine.plan.stages.map((s) => s.name)).toEqual(['需求评审', '技术方案', '开发'])
    expect(st.status).toBe('running')
  })

  it('injects a liveLane (cwd=workspace) for the current conversational stage so its card is run + can load context', () => {
    const st = toWorkflowProgressState(wf({ currentIndex: 1 }), '/ws')
    expect(st.liveLanes['design:root']).toEqual({ stageKey: 'design', cwd: '/ws' })
    // and the current stage renders as a running root card via the SAME adapter RunExecPanel uses
    const stages = buildStageRuntimes(st, {}, new Map())
    const design = stages.find((s) => s.key === 'design')!
    expect(design.agents[0].state).toBe('run')
    expect(design.agents[0].cwd).toBe('/ws')
  })

  it('done phase marks every stage done and status ok, no liveLane', () => {
    const st = toWorkflowProgressState(wf({ currentIndex: 3, phase: 'done' }), '/ws')
    expect(st.machine.stages.every((s) => s.status === 'done')).toBe(true)
    expect(st.status).toBe('ok')
    expect(Object.keys(st.liveLanes)).toHaveLength(0)
  })

  it('seeds projects so an upcoming fan-out stage previews one wait card per project', () => {
    const st = toWorkflowProgressState(wf({ currentIndex: 0 }), '/ws')
    const stages = buildStageRuntimes(st, {}, new Map())
    const dev = stages.find((s) => s.key === 'dev')!
    expect(dev.agents.map((a) => a.name)).toEqual(['app'])
    expect(dev.agents[0].state).toBe('wait')
  })
})
