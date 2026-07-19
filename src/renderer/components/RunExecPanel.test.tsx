import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RunExecPanel } from './RunExecPanel'
import type { Run2Api } from '../state/useRun2'

function makeRun2(state: any = null, laneLogs: Record<string, any[]> = {}): Run2Api {
  return {
    state,
    laneLogs,
    queueLength: 0,
    start: vi.fn(),
    resolveGate: vi.fn(),
    resolveLane: vi.fn(),
    addFeedback: vi.fn(),
    editFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    jumpBack: vi.fn(),
  } as unknown as Run2Api
}

function baseState(overrides: Partial<Record<string, unknown>> = {}) {
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
    stageTimings: {
      assess: { startedAt: 0, endedAt: 500 },
      design: { startedAt: 500, endedAt: 1500 },
      develop: { startedAt: 1500 },
    },
    paused: false,
    ...overrides,
  }
}

beforeEach(() => {
  ;(window as any).forge = {}
})

describe('RunExecPanel', () => {
  it('renders progress, stage names, and fan-out lane cards (project name + state)', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)

    expect(screen.getByText('已完成 2 / 4')).toBeInTheDocument()
    expect(screen.getByText('分支：—')).toBeInTheDocument()

    // Stage headers (.stage-name) — one per stage.
    expect(document.querySelectorAll('.stage-name')).toHaveLength(4)
    expect(screen.getAllByText('需求评估').length).toBeGreaterThan(0)
    expect(screen.getAllByText('技术方案设计').length).toBeGreaterThan(0)
    expect(screen.getAllByText('代码开发').length).toBeGreaterThan(0)
    expect(screen.getAllByText('代码评审').length).toBeGreaterThan(0)

    // Fan-out lanes for the running per-project stage render as AgentNode cards, one per project.
    const goBlogCard = screen.getByText('go-blog').closest('.agent-node')
    expect(goBlogCard).not.toBeNull()
    expect(goBlogCard!.querySelector('.agent-state')?.textContent).toContain('执行中')

    const zghCard = screen.getByText('zgh').closest('.agent-node')
    expect(zghCard).not.toBeNull()
    expect(zghCard!.querySelector('.agent-state')?.textContent).toContain('完成')
  })

  it('does not render any per-node decision action (gate/auth/failure buttons)', () => {
    const gatedState = baseState({
      inbox: [{ id: 'g1', kind: 'gate', stageKey: 'design', body: '方案已就绪' }],
    })
    const run2 = makeRun2(gatedState)
    render(<RunExecPanel run2={run2} />)

    expect(screen.queryByText('确认继续')).toBeNull()
    expect(screen.queryByText('批准')).toBeNull()
    expect(screen.queryByText('重跑')).toBeNull()
    expect(screen.queryByText('要求修改')).toBeNull()
    expect(screen.queryByText('拒绝')).toBeNull()
    expect(screen.queryByText('跳过')).toBeNull()
    expect(screen.queryByText('提交')).toBeNull()
    expect(document.querySelector('.wfo-act')).toBeNull()
  })

  it('shows run-level 暂停/终止 controls and wires them to run2', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)

    const pauseBtn = screen.getByText('暂停')
    fireEvent.click(pauseBtn)
    expect(run2.pause).toHaveBeenCalled()

    const abortBtn = screen.getByText(/终止/)
    fireEvent.click(abortBtn)
    expect(run2.abort).toHaveBeenCalled()
  })

  it('shows 继续 instead of 暂停 when the run is paused, wired to resume', () => {
    const run2 = makeRun2(baseState({ paused: true }))
    render(<RunExecPanel run2={run2} />)

    const resumeBtn = screen.getByText('继续')
    fireEvent.click(resumeBtn)
    expect(run2.resume).toHaveBeenCalled()
    expect(screen.queryByText('暂停')).toBeNull()
  })

  it('renders "—" for tempBranch when the plan does not have one yet', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('分支：—')).toBeInTheDocument()
  })

  it('Finding 1: a finalize-gate merge conflict shows the real error, not the generic "存在失败阶段" banner', () => {
    // Every stage done (100%), no FailureEvent, no failed WorkOrderOutcome anywhere — this is the
    // finalize-merge-conflict shape: `runFinalizeGate` set state.error and the run ended 'failed'
    // even though every stage itself succeeded.
    const state = baseState({
      status: 'failed',
      error: '合并临时分支失败 — a: CONFLICT (content): Merge conflict in app.ts',
      machine: {
        plan: baseState().machine.plan,
        stages: [
          { key: 'assess', status: 'done', round: 0 },
          { key: 'design', status: 'done', round: 0 },
          { key: 'develop', status: 'done', round: 0 },
          { key: 'review', status: 'done', round: 0 },
        ],
        currentIndex: 4,
      },
      outcomes: {
        develop: [
          { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'ok', attempts: 1 },
        ],
      },
    })
    const run2 = makeRun2(state)
    render(<RunExecPanel run2={run2} />)

    expect(screen.getByText(/合并临时分支失败.*CONFLICT/)).toBeInTheDocument()
    expect(screen.queryByText('工作流已结束 · 存在失败阶段，请检查后处理')).toBeNull()
  })

  it('a genuine per-lane stage failure (no state.error) keeps the existing "存在失败阶段" text', () => {
    const state = baseState({
      status: 'failed',
      outcomes: {
        develop: [
          { order: { id: 'develop:zgh', stageKey: 'develop', name: '代码开发', project: 'zgh', provider: 'claude', model: 'sonnet-4.6', cwd: '/ws/zgh', prompt: '' }, status: 'failed', error: 'boom', attempts: 1 },
        ],
      },
    })
    const run2 = makeRun2(state)
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('工作流已结束 · 存在失败阶段，请检查后处理')).toBeInTheDocument()
  })

  it('a plain abort (no error, no failed outcome) shows a neutral "已结束" instead of the misleading banner', () => {
    const state = baseState({ status: 'failed' })
    const run2 = makeRun2(state)
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('工作流已结束')).toBeInTheDocument()
    expect(screen.queryByText('工作流已结束 · 存在失败阶段，请检查后处理')).toBeNull()
  })

  it('renders a 已失效 marker on a stale (jumped-back-past) stage, and only on that stage', () => {
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
    const run2 = makeRun2(staleState)
    render(<RunExecPanel run2={run2} />)

    const staleChips = screen.getAllByText('已失效')
    expect(staleChips).toHaveLength(2)
    // The marker sits inside the invalidated stages' own header, not the running/pending ones.
    const designHeader = screen.getAllByText('技术方案设计')[0].closest('.stage-head')!
    const developHeader = screen.getAllByText('代码开发')[0].closest('.stage-head')!
    const assessHeader = screen.getAllByText('需求评估')[0].closest('.stage-head')!
    const reviewHeader = screen.getAllByText('代码评审')[0].closest('.stage-head')!
    expect(designHeader.querySelector('.stage-stale')).not.toBeNull()
    expect(developHeader.querySelector('.stage-stale')).not.toBeNull()
    expect(assessHeader.querySelector('.stage-stale')).toBeNull()
    expect(reviewHeader.querySelector('.stage-stale')).toBeNull()
  })

  it('renders nothing but an idle message when there is no active run', () => {
    const run2 = makeRun2(null)
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('无正在运行的工作流')).toBeInTheDocument()
    expect(screen.queryByText('暂停')).toBeNull()
    expect(screen.queryByText(/终止/)).toBeNull()
  })
})
