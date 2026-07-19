import { describe, it, expect } from 'vitest'
import { buildStageRuntimes, type LaneMemory } from './runExecAdapter'
import type { RunControllerState, RunLogLine } from '../../main/run/controller'

function baseState(overrides: Partial<Record<string, unknown>> = {}): RunControllerState {
  return {
    machine: {
      plan: {
        runId: 'run2-1',
        stages: [
          { key: 'assess', name: '需求评估', provider: 'claude', model: 'opus', scope: 'root', gate: false, prompt: '评估需求' },
          { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root', gate: true, prompt: '设计技术方案' },
          { key: 'develop', name: '代码开发', provider: 'codex', model: 'gpt-5-codex', scope: 'per-project', gate: false, prompt: '实现代码变更' },
          { key: 'review', name: '代码评审', provider: 'claude', model: 'opus', scope: 'root', gate: false, prompt: '评审代码' },
        ],
      },
      stages: [
        { key: 'assess', status: 'done', round: 0 },
        { key: 'design', status: 'done', round: 0 },
        { key: 'develop', status: 'running', round: 0 },
        { key: 'review', status: 'pending', round: 0 },
      ],
      currentIndex: 2,
    },
    inbox: [],
    feedback: [],
    outcomes: {
      develop: [
        { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'ok', attempts: 1 },
      ],
    },
    status: 'running',
    pendingDirective: {},
    liveLanes: {
      'develop:go-blog': { stageKey: 'develop', project: 'go-blog', state: 'run', cwd: '/ws/go-blog' },
    },
    stageTimings: {},
    paused: false,
    ...overrides,
  } as unknown as RunControllerState
}

describe('buildStageRuntimes', () => {
  it('maps root-scope stages to a single agent named/roled after the stage', () => {
    const stages = buildStageRuntimes(baseState(), {})
    const assess = stages.find((s) => s.key === 'assess')!
    expect(assess.agents).toHaveLength(1)
    expect(assess.agents[0].id).toBe('assess:root')
    expect(assess.agents[0].name).toBe('需求评估')
    expect(assess.agents[0].role).toBe('需求评估')
    expect(assess.agents[0].provider).toBe('claude')
    expect(assess.agents[0].model).toBe('opus')
    // machine status 'done' with no outcome recorded → 'ok'
    expect(assess.agents[0].state).toBe('ok')
    expect(assess.state).toBe('ok')
  })

  it('maps per-project fan-out lanes from liveLanes (running) and outcomes (settled)', () => {
    const stages = buildStageRuntimes(baseState(), {})
    const develop = stages.find((s) => s.key === 'develop')!
    expect(develop.agents.map((a) => a.name).sort()).toEqual(['go-blog', 'zgh'])

    const goBlog = develop.agents.find((a) => a.name === 'go-blog')!
    expect(goBlog.id).toBe('develop:go-blog')
    expect(goBlog.state).toBe('run')
    expect(goBlog.cwd).toBe('/ws/go-blog')

    const zgh = develop.agents.find((a) => a.name === 'zgh')!
    expect(zgh.state).toBe('ok')
    expect(zgh.provider).toBe('claude') // from the settled outcome's order, not the stage plan
    expect(zgh.model).toBe('sonnet-4.6')
    expect(zgh.cwd).toBe('/ws/zgh')

    // Stage-level aggregate: verbatim-ported `stageRunState` semantics treat ANY 'ok' outcome in
    // the stage (no failure/awaiting signal present) as enough to call the whole stage 'ok', even
    // while another lane is still live — a pre-existing quirk carried over from the old
    // RunExecPanel, not something introduced here (see task report's "concerns").
    expect(develop.state).toBe('ok')
  })

  it('surfaces a failed outcome as an err lane, and reports the stage as err even though the machine still says running', () => {
    const failedState = baseState({
      outcomes: {
        develop: [
          { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'failed', error: 'boom', attempts: 1 },
        ],
      },
    })
    const stages = buildStageRuntimes(failedState, {})
    const develop = stages.find((s) => s.key === 'develop')!
    expect(develop.state).toBe('err')
    expect(develop.agents.find((a) => a.name === 'zgh')!.state).toBe('err')
  })

  it('marks a stage/lane awaiting when a gate/auth/question event targets it, without letting a settled outcome be overridden', () => {
    const gatedState = baseState({
      inbox: [
        { id: 'g1', kind: 'gate', stageKey: 'design', body: '方案已就绪' },
        { id: 'q1', kind: 'question', stageKey: 'develop', laneId: 'develop:go-blog', title: '需要澄清?' },
      ],
    })
    const stages = buildStageRuntimes(gatedState, {})
    expect(stages.find((s) => s.key === 'design')!.state).toBe('awaiting')

    const develop = stages.find((s) => s.key === 'develop')!
    expect(develop.state).toBe('awaiting') // any lane awaiting → whole stage awaiting
    expect(develop.agents.find((a) => a.name === 'go-blog')!.state).toBe('awaiting')
    // zgh already settled 'ok' via its outcome — the (stage-wide-looking) gate/question inbox
    // entries above are laneId-scoped to go-blog, so zgh's own settled result must not flip.
    expect(develop.agents.find((a) => a.name === 'zgh')!.state).toBe('ok')
  })

  it('maps log lines through: (laneLogs[laneId] ?? []).map(r => r.line)', () => {
    const laneLogs: Record<string, RunLogLine[]> = {
      'develop:go-blog': [
        { laneId: 'develop:go-blog', stageKey: 'develop', project: 'go-blog', agentName: '代码开发', line: { ts: '00:00:01', text: 'hello', level: 'info' } },
      ],
    }
    const stages = buildStageRuntimes(baseState(), laneLogs)
    const goBlog = stages.find((s) => s.key === 'develop')!.agents.find((a) => a.name === 'go-blog')!
    expect(goBlog.logs).toEqual([{ ts: '00:00:01', text: 'hello', level: 'info' }])
  })

  it('shows an empty agents list for a per-project stage with no lanes yet (nothing live, no outcomes, no memory)', () => {
    const noLaneState = baseState({
      outcomes: {},
      liveLanes: {},
    })
    const stages = buildStageRuntimes(noLaneState, {})
    expect(stages.find((s) => s.key === 'develop')!.agents).toEqual([])
  })

  it('persists a fan-out lane through a momentary gap via caller-owned memory (no fresh live/outcome this tick)', () => {
    const memory = new Map<string, Map<string, LaneMemory>>()
    // Tick 1: go-blog is live.
    buildStageRuntimes(baseState(), {}, memory)
    // Tick 2: go-blog just settled and is momentarily absent from both liveLanes and outcomes.
    const gapState = baseState({ liveLanes: {} })
    const stages = buildStageRuntimes(gapState, {}, memory)
    const develop = stages.find((s) => s.key === 'develop')!
    const goBlog = develop.agents.find((a) => a.name === 'go-blog')
    expect(goBlog).toBeDefined()
    // No fresh signal → falls back to its last-known state (was 'run').
    expect(goBlog!.state).toBe('run')
  })
})
