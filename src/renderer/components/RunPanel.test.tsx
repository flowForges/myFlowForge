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

    // current-stage lane: outcome for the "dev" stage's project shows up
    expect(screen.getByText(/app/)).toBeInTheDocument()

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
})
