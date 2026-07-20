// Item ⑤: a historical run's persisted provider/model (and cwd) must survive
// toHistoricalState()'s SavedOutcome → WorkOrderOutcome reconstruction, so runExecAdapter's
// buildStageRuntimes (fed this adapted state — see RunExecPanel) renders real chips instead of
// blanks/stage-plan defaults for a per-project fan-out lane with a project-level provider override.
import { describe, it, expect } from 'vitest'
import { toHistoricalState } from './runHistoryAdapter'
import { buildStageRuntimes } from './runExecAdapter'
import type { SavedControllerState } from '../../main/run/persist'

const rootPlan: SavedControllerState['machine']['plan'] = {
  runId: 'r1',
  stages: [{ key: 'design', name: 'D', provider: 'stage-default', model: 'stage-model', scope: 'root', gate: false }],
}

describe('toHistoricalState', () => {
  it('maps persisted provider/model/cwd onto the reconstructed order (root scope)', () => {
    const saved: SavedControllerState = {
      machine: { plan: rootPlan, stages: [{ key: 'design', status: 'done', round: 0 }], currentIndex: 0 },
      inbox: [], feedback: [],
      outcomes: { design: [{ id: 'design:root', status: 'ok', attempts: 1, provider: 'codex', model: 'gpt-5', cwd: '/ws/go-blog' }] },
      status: 'ok', pendingDirective: {}, stageTimings: {},
    } as unknown as SavedControllerState

    const state = toHistoricalState(saved)
    expect(state.outcomes.design[0].order).toMatchObject({ provider: 'codex', model: 'gpt-5', cwd: '/ws/go-blog' })

    // And end-to-end through the same adapter a live run's AgentNode reads from.
    const stages = buildStageRuntimes(state, {})
    expect(stages[0].agents[0]).toMatchObject({ provider: 'codex', model: 'gpt-5', cwd: '/ws/go-blog' })
  })

  it('a per-project fan-out lane shows its OWN persisted provider/model, not the stage default', () => {
    const fanoutPlan: SavedControllerState['machine']['plan'] = {
      runId: 'r1',
      stages: [{ key: 'develop', name: 'Develop', provider: 'stage-default', model: 'stage-model', scope: 'per-project', gate: false }],
    }
    const saved: SavedControllerState = {
      machine: { plan: fanoutPlan, stages: [{ key: 'develop', status: 'done', round: 0 }], currentIndex: 0 },
      inbox: [], feedback: [],
      outcomes: {
        develop: [
          { id: 'develop:go-blog', status: 'ok', attempts: 1, project: 'go-blog', provider: 'claude', model: 'sonnet', cwd: '/ws/go-blog' },
          { id: 'develop:api', status: 'ok', attempts: 1, project: 'api', provider: 'codex', model: 'gpt-5', cwd: '/ws/api' },
        ],
      },
      status: 'ok', pendingDirective: {}, stageTimings: {},
    } as unknown as SavedControllerState

    const state = toHistoricalState(saved)
    const stages = buildStageRuntimes(state, {})
    const byProject = Object.fromEntries(stages[0].agents.map((a) => [a.name, a]))
    expect(byProject['go-blog']).toMatchObject({ provider: 'claude', model: 'sonnet', cwd: '/ws/go-blog' })
    expect(byProject['api']).toMatchObject({ provider: 'codex', model: 'gpt-5', cwd: '/ws/api' })
  })

  it('a legacy saved outcome without provider/model/cwd falls back to the stage plan defaults, not throwing', () => {
    const saved: SavedControllerState = {
      machine: { plan: rootPlan, stages: [{ key: 'design', status: 'done', round: 0 }], currentIndex: 0 },
      inbox: [], feedback: [],
      outcomes: { design: [{ id: 'design:root', status: 'ok', attempts: 1 }] },
      status: 'ok', pendingDirective: {}, stageTimings: {},
    } as unknown as SavedControllerState

    const state = toHistoricalState(saved)
    expect(state.outcomes.design[0].order.provider).toBe('')
    const stages = buildStageRuntimes(state, {})
    // runExecAdapter's `||` fallback picks up the stage plan's own provider/model here.
    expect(stages[0].agents[0]).toMatchObject({ provider: 'stage-default', model: 'stage-model' })
  })
})
