import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RunPanel } from './RunPanel'
import type { Run2Api } from '../state/useRun2'
import type { RunControllerState } from '../../main/run/controller'

function makeState(overrides?: Partial<RunControllerState>): RunControllerState {
  const base: RunControllerState = {
    machine: {
      plan: { runId: 'r1', stages: [] },
      stages: [
        { key: 'design', status: 'done', round: 0 },
        { key: 'dev', status: 'running', round: 0 },
        { key: 'review', status: 'pending', round: 0 },
      ],
      currentIndex: 1,
    },
    inbox: [
      { id: 'g1', kind: 'gate', stageKey: 'dev', body: '## 方案\n完成', docs: [] },
    ],
    feedback: [{ id: 'fb1', text: '别忘了加测试' }],
    outcomes: {
      dev: [
        { order: { id: 'w1', stageKey: 'dev', name: 'dev-lane', project: 'app', provider: 'claude', model: 'sonnet', cwd: '/tmp/app', prompt: '' }, status: 'ok', attempts: 1 },
      ],
    },
    status: 'awaiting',
    pendingDirective: {},
    liveLanes: {},
  }
  return { ...base, ...overrides }
}

function makeApi(state: RunControllerState | null): Run2Api {
  return {
    state,
    resolveGate: vi.fn(),
    resolveLane: vi.fn(),
    addFeedback: vi.fn(),
    editFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    abort: vi.fn(),
  }
}

describe('RunPanel', () => {
  it('renders placeholder when state is null', () => {
    const api = makeApi(null)
    render(<RunPanel api={api} />)
    expect(screen.getByText('未在运行工作流')).toBeInTheDocument()
  })

  it('renders stage flow, current-stage lane, event card, and feedback draft; cancel calls abort', () => {
    const api = makeApi(makeState())
    render(<RunPanel api={api} />)

    // stage flow: all three stage keys present
    expect(screen.getByText('design')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.getByText('review')).toBeInTheDocument()

    // current-stage lane: outcome for the "dev" stage's project shows up (also mirrored in the
    // new stage-output region below, since selectedStageKey defaults to the current stage 'dev')
    expect(screen.getAllByText(/app/).length).toBeGreaterThan(0)

    // event inbox: the gate event card is rendered with its [通过] action
    const passBtn = screen.getByText('通过')
    expect(passBtn).toBeInTheDocument()
    fireEvent.click(passBtn)
    expect(api.resolveGate).toHaveBeenCalledWith('g1', { type: 'advance' })

    // feedback draft
    expect(screen.getByDisplayValue('别忘了加测试')).toBeInTheDocument()

    // cancel run
    fireEvent.click(screen.getByText('取消运行'))
    expect(api.abort).toHaveBeenCalled()
  })

  it('shows empty-inbox message when inbox is empty', () => {
    const state = makeState({ inbox: [] })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    expect(screen.getByText('运行中，暂无待办')).toBeInTheDocument()
  })

  it('feedback input submit calls addFeedback', () => {
    const state = makeState({ feedback: [] })
    const api = makeApi(state)
    render(<RunPanel api={api} />)
    const input = screen.getByPlaceholderText('补充反馈…') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新反馈' } })
    fireEvent.click(screen.getByText('添加'))
    expect(api.addFeedback).toHaveBeenCalledWith('新反馈')
  })

  it('renders live lanes for the current stage when outcomes are empty, and hides the empty state', () => {
    const state = makeState({
      outcomes: {},
      liveLanes: {
        'design:root': { stageKey: 'design', state: 'run', activity: '写 design.md' },
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)

    // Note: makeState's default currentIndex is 1 (the 'dev' stage). The 'design' stage's
    // live lane belongs to a different stage, so it should NOT render.
    expect(screen.queryByText('写 design.md')).not.toBeInTheDocument()
  })

  it('renders live lanes for the CURRENT stage and suppresses the empty state', () => {
    const state = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [
          { key: 'design', status: 'running', round: 0 },
          { key: 'dev', status: 'pending', round: 0 },
          { key: 'review', status: 'pending', round: 0 },
        ],
        currentIndex: 0,
      },
      outcomes: {},
      liveLanes: {
        'design:root': { stageKey: 'design', state: 'run', activity: '写 design.md' },
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)

    // Mirrored in both the current-stage lane and the stage-output region (selectedStageKey
    // defaults to the current stage 'design').
    expect(screen.getAllByText('写 design.md').length).toBeGreaterThan(0)
    expect(screen.queryByText('暂无进展')).not.toBeInTheDocument()
  })

  it('editFeedback and removeFeedback are wired to the feedback row', () => {
    const api = makeApi(makeState())
    render(<RunPanel api={api} />)
    const editable = screen.getByDisplayValue('别忘了加测试') as HTMLInputElement
    fireEvent.change(editable, { target: { value: '改一下' } })
    fireEvent.blur(editable)
    expect(api.editFeedback).toHaveBeenCalledWith('fb1', '改一下')

    fireEvent.click(screen.getByTitle('删除反馈'))
    expect(api.removeFeedback).toHaveBeenCalledWith('fb1')
  })

  it('stage output: renders selected stage outcome summary/files/doubts, and switching stage chips switches the shown output', () => {
    const state = makeState({
      machine: {
        plan: { runId: 'r1', stages: [] },
        stages: [
          { key: 'design', status: 'done', round: 0 },
          { key: 'dev', status: 'running', round: 0 },
          { key: 'review', status: 'pending', round: 0 },
        ],
        currentIndex: 1,
      },
      outcomes: {
        design: [
          {
            order: { id: 'design:root', stageKey: 'design', name: 'design-lane', project: undefined, provider: 'claude', model: 'sonnet', cwd: '/tmp', prompt: '' },
            status: 'ok',
            attempts: 1,
            result: { summary: '技术方案：用 X 架构', filesChanged: ['design.md'], blockers: [], doubts: ['是否加缓存'], artifacts: [] },
          },
        ],
        dev: [
          { order: { id: 'w1', stageKey: 'dev', name: 'dev-lane', project: 'app', provider: 'claude', model: 'sonnet', cwd: '/tmp/app', prompt: '' }, status: 'ok', attempts: 1 },
        ],
      },
    })
    const api = makeApi(state)
    render(<RunPanel api={api} />)

    // Default selected stage follows the current stage ('dev'); its outcome has no `result`,
    // so the design stage's output must not be showing yet.
    expect(screen.queryByText('技术方案：用 X 架构')).not.toBeInTheDocument()

    // Click the 'design' stage chip → its outcome's output renders.
    fireEvent.click(screen.getByText('design'))
    expect(screen.getByText(/技术方案：用 X 架构/)).toBeInTheDocument()
    expect(screen.getByText('design.md')).toBeInTheDocument()
    expect(screen.getByText(/是否加缓存/)).toBeInTheDocument()
  })
})
