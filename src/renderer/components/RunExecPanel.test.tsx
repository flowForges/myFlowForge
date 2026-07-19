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
  it('renders progress, stage names, and fan-out lane names/statuses', () => {
    const run2 = makeRun2(baseState())
    render(<RunExecPanel run2={run2} />)

    expect(screen.getByText('已完成 2 / 4')).toBeInTheDocument()
    expect(screen.getByText('需求评估')).toBeInTheDocument()
    expect(screen.getByText('技术方案设计')).toBeInTheDocument()
    expect(screen.getByText('代码开发')).toBeInTheDocument()
    expect(screen.getByText('代码评审')).toBeInTheDocument()

    expect(screen.getByText('go-blog')).toBeInTheDocument()
    expect(screen.getByText('zgh')).toBeInTheDocument()
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

  it('renders nothing but an idle message when there is no active run', () => {
    const run2 = makeRun2(null)
    render(<RunExecPanel run2={run2} />)
    expect(screen.getByText('无正在运行的工作流')).toBeInTheDocument()
    expect(screen.queryByText('暂停')).toBeNull()
    expect(screen.queryByText(/终止/)).toBeNull()
  })
})
