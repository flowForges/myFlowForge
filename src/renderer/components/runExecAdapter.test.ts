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

    // Stage-level aggregate: zgh settled 'ok' but go-blog is still live ('run') — the whole stage
    // must NOT flip to 'ok' while a sibling fan-out lane is still running (P2-1b fix).
    expect(develop.state).toBe('run')
  })

  it('keeps a fan-out stage as run while one lane is ok and a sibling lane is still running (not ok)', () => {
    const stages = buildStageRuntimes(
      baseState({
        outcomes: {
          develop: [
            { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'ok', attempts: 1 },
          ],
        },
        liveLanes: {
          'develop:go-blog': { stageKey: 'develop', project: 'go-blog', state: 'run', cwd: '/ws/go-blog' },
        },
      }),
      {}
    )
    const develop = stages.find((s) => s.key === 'develop')!
    expect(develop.agents.find((a) => a.name === 'zgh')!.state).toBe('ok')
    expect(develop.agents.find((a) => a.name === 'go-blog')!.state).toBe('run')
    // Any lane still running → whole stage is 'run', NOT 'ok' — the bug this test guards against.
    expect(develop.state).toBe('run')
  })

  it('marks a fan-out stage ok once every known lane has itself settled ok', () => {
    const stages = buildStageRuntimes(
      baseState({
        outcomes: {
          develop: [
            { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'ok', attempts: 1 },
            { order: { id: 'develop:go-blog', stageKey: 'develop', name: '代码开发', project: 'go-blog', provider: 'codex', model: 'gpt-5-codex', cwd: '/ws/go-blog', prompt: '' }, status: 'ok', attempts: 1 },
          ],
        },
        liveLanes: {},
      }),
      {}
    )
    const develop = stages.find((s) => s.key === 'develop')!
    expect(develop.agents.every((a) => a.state === 'ok')).toBe(true)
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

  it('marks a stage stale (jump-back invalidation) via a dedicated flag, without touching sibling stages', () => {
    const staleState = baseState({
      machine: {
        plan: baseState().machine.plan,
        stages: [
          { key: 'assess', status: 'running', round: 1 },
          { key: 'design', status: 'stale', round: 0 },
          { key: 'develop', status: 'stale', round: 0 },
          { key: 'review', status: 'pending', round: 0 },
        ],
        currentIndex: 0,
      },
    })
    const stages = buildStageRuntimes(staleState, {})
    expect(stages.find((s) => s.key === 'design')!.stale).toBe(true)
    expect(stages.find((s) => s.key === 'develop')!.stale).toBe(true)
    // A running/pending stage that was never jumped past is not stale.
    expect(stages.find((s) => s.key === 'assess')!.stale).toBeFalsy()
    expect(stages.find((s) => s.key === 'review')!.stale).toBeFalsy()
  })

  // Improvement ⑥: per-lane execution timing (RunControllerState.laneTimings, keyed by the same
  // laneId as liveLanes/outcomes) must be threaded onto the adapted agent so AgentNode can render
  // an elapsed chip — for both a root-scope stage's single agent and a per-project fan-out lane.
  it('threads laneTimings onto the adapted agent (root-scope) as laneStartedAt/laneEndedAt', () => {
    const state = baseState({
      laneTimings: { 'assess:root': { startedAt: 1000, endedAt: 4500 } },
    })
    const stages = buildStageRuntimes(state, {})
    const assess = stages.find((s) => s.key === 'assess')!.agents[0]
    expect(assess.laneStartedAt).toBe(1000)
    expect(assess.laneEndedAt).toBe(4500)
  })

  it('threads laneTimings onto per-project fan-out lanes, one entry per lane', () => {
    const state = baseState({
      laneTimings: {
        'develop:zgh': { startedAt: 2000, endedAt: 2800 },
        'develop:go-blog': { startedAt: 2100 }, // still running: no endedAt
      },
    })
    const stages = buildStageRuntimes(state, {})
    const develop = stages.find((s) => s.key === 'develop')!
    const zgh = develop.agents.find((a) => a.name === 'zgh')!
    const goBlog = develop.agents.find((a) => a.name === 'go-blog')!
    expect(zgh.laneStartedAt).toBe(2000)
    expect(zgh.laneEndedAt).toBe(2800)
    expect(goBlog.laneStartedAt).toBe(2100)
    expect(goBlog.laneEndedAt).toBeUndefined()
  })

  it('leaves laneStartedAt/laneEndedAt undefined when no laneTimings entry exists for a lane', () => {
    const stages = buildStageRuntimes(baseState(), {})
    const assess = stages.find((s) => s.key === 'assess')!.agents[0]
    expect(assess.laneStartedAt).toBeUndefined()
    expect(assess.laneEndedAt).toBeUndefined()
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
