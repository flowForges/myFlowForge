import { describe, it, expect } from 'vitest'
import { advanceWorkflow, advanceCrossesProvider, executionTail, currentStage, isExecutionStage, type WorkflowSessionState, type WorkflowStageView } from './workflowSession'

const stage = (over: Partial<WorkflowStageView> & { key: string }): WorkflowStageView => ({
  name: over.key, provider: 'claude', model: 'opus', scope: 'root', ...over,
})

function mk(stages: WorkflowStageView[], currentIndex = 0): WorkflowSessionState {
  return { flowId: 'f', flowName: 'F', stages, currentIndex, phase: 'chatting', projects: [] }
}

describe('advanceWorkflow', () => {
  it('advances a conversational stage → next conversational stage stays chatting', () => {
    const ws = mk([stage({ key: 'requirement' }), stage({ key: 'design' })])
    const next = advanceWorkflow(ws)
    expect(next.currentIndex).toBe(1)
    expect(next.phase).toBe('chatting')
  })

  it('advancing INTO a per-project (扇出) stage flips phase to executing', () => {
    const ws = mk([stage({ key: 'design' }), stage({ key: 'develop', scope: 'per-project' })])
    const next = advanceWorkflow(ws)
    expect(next.currentIndex).toBe(1)
    expect(next.phase).toBe('executing')
  })

  it('advancing past the last stage flips phase to done', () => {
    const ws = mk([stage({ key: 'design' })], 0)
    const next = advanceWorkflow(ws)
    expect(next.phase).toBe('done')
    expect(next.currentIndex).toBe(1)
  })

  it('does not mutate the input', () => {
    const ws = mk([stage({ key: 'a' }), stage({ key: 'b' })])
    advanceWorkflow(ws)
    expect(ws.currentIndex).toBe(0)
    expect(ws.phase).toBe('chatting')
  })
})

describe('advanceCrossesProvider', () => {
  it('true when the next stage uses a different provider', () => {
    const ws = mk([stage({ key: 'design', provider: 'claude' }), stage({ key: 'develop', provider: 'codex' })])
    expect(advanceCrossesProvider(ws)).toBe(true)
  })
  it('false when same provider', () => {
    const ws = mk([stage({ key: 'design', provider: 'claude' }), stage({ key: 'develop', provider: 'claude' })])
    expect(advanceCrossesProvider(ws)).toBe(false)
  })
  it('false at the last stage (no next)', () => {
    const ws = mk([stage({ key: 'design' })], 0)
    expect(advanceCrossesProvider(ws)).toBe(false)
  })
})

describe('executionTail / currentStage / isExecutionStage', () => {
  it('executionTail returns all stages from the given index', () => {
    const ws = mk([stage({ key: 'a' }), stage({ key: 'b', scope: 'per-project' }), stage({ key: 'c', scope: 'per-project' })])
    expect(executionTail(ws, 1).map((s) => s.key)).toEqual(['b', 'c'])
  })
  it('currentStage reads stages[currentIndex]', () => {
    const ws = mk([stage({ key: 'a' }), stage({ key: 'b' })], 1)
    expect(currentStage(ws)?.key).toBe('b')
  })
  it('isExecutionStage true only for per-project', () => {
    expect(isExecutionStage(stage({ key: 'x', scope: 'per-project' }))).toBe(true)
    expect(isExecutionStage(stage({ key: 'y', scope: 'root' }))).toBe(false)
    expect(isExecutionStage(undefined)).toBe(false)
  })
})
