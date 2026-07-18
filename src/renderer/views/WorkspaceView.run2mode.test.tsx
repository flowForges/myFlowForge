import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'
import type { RunControllerState } from '../../main/run/controller'

// Task 1: the old chat|run2 `.run2-mode-toggle` segmented control is replaced by a `runView`
// boolean driven by the run2 controller's status lifecycle ('running'/'awaiting' auto-opens the
// run view), plus explicit user control via "返回对话" / "查看运行中".

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }
]

const wsConfig = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [
    { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', provider: 'claude', model: 'opus-4.8' },
  ],
  projects: [{ repoId: 'r1', name: 'web', branch: 'feat/cool', provider: 'claude', model: 'opus-4.8' }],
}

function makeRunState(overrides?: Partial<RunControllerState>): RunControllerState {
  const base: RunControllerState = {
    machine: {
      plan: { runId: 'r1', stages: [] },
      stages: [
        { key: 'design', status: 'done', round: 0 },
        { key: 'dev', status: 'running', round: 0 },
      ],
      currentIndex: 1,
    },
    inbox: [],
    feedback: [],
    outcomes: {},
    status: 'running',
    pendingDirective: {},
    liveLanes: {},
  } as any
  return { ...base, ...overrides }
}

let emitRun2Update: (p: { workspacePath: string; state: RunControllerState }) => void = () => {}
const getStateMock = vi.fn(async () => null as RunControllerState | null)
const launchInfoMock = vi.fn(async () => ({ workflows: [], projects: [] }))

const forgeBase = {
  chatHistory: async () => [], sendChat: vi.fn(async () => ({})), openFiles: async () => [], savePaste: vi.fn(),
  onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
  sessionList: async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }),
  sessionSwitch: vi.fn(), sessionNew: vi.fn(), sessionClose: vi.fn(), sessionRename: vi.fn(),
  watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
  gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
  onChangesEvent: () => () => {},
  lastRun: async () => null,
  getWorkspace: vi.fn(async () => wsConfig),
  runWorkspace: vi.fn(async () => {}),
  run2: {
    getState: getStateMock,
    onUpdate: (cb: any) => { emitRun2Update = cb; return () => {} },
    resolveGate: vi.fn(),
    resolveLane: vi.fn(),
    addFeedback: vi.fn(),
    editFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    abort: vi.fn(),
    launchInfo: launchInfoMock,
    startWorkflow: vi.fn(),
  },
}

beforeEach(() => {
  getStateMock.mockClear()
  launchInfoMock.mockClear()
  ;(window as any).forge = { ...forgeBase }
  ;(window as any).confirm = vi.fn(() => true)
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

describe('WorkspaceView run2 lifecycle (runView replaces mode2 toggle)', () => {
  it('no run: shows chat, no toggle buttons, no reopen chip', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    // The old segmented toggle is gone entirely.
    expect(document.querySelector('.run2-mode-toggle')).toBeNull()
    expect(screen.queryByText('对话', { selector: 'button' })).toBeNull()
    expect(screen.queryByText('工作流运行')).toBeNull()
    // No run active → no reopen chip either.
    expect(screen.queryByText(/查看运行中|工作流运行中/)).toBeNull()
  })

  it('run2 status becomes running: run view auto-opens (WorkflowOverlay run mode visible)', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    act(() => {
      emitRun2Update({ workspacePath: '/ws', state: makeRunState({ status: 'running' }) })
    })

    await waitFor(() => expect(screen.getByText('返回对话')).toBeInTheDocument())
    expect(document.querySelector('.wfo-runctl')).toBeInTheDocument() // WorkflowOverlay run-mode foot
    expect(screen.getByText('终止')).toBeInTheDocument()
    expect(document.querySelector('#composerInput')).toBeNull() // chat column hidden
  })

  it('返回对话 goes back to chat and shows "查看运行中" chip (with inbox badge) while run keeps running; clicking chip reopens run view', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    act(() => {
      emitRun2Update({
        workspacePath: '/ws',
        state: makeRunState({ status: 'running', inbox: [{ id: 'g1', kind: 'gate', stageKey: 'dev', body: 'x', docs: [] } as any] }),
      })
    })
    await waitFor(() => expect(screen.getByText('返回对话')).toBeInTheDocument())

    fireEvent.click(screen.getByText('返回对话'))

    // Back to chat.
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    expect(screen.queryByText('返回对话')).toBeNull()

    // Reopen chip present with inbox badge (1 pending event).
    const chip = await screen.findByText('⟳ 工作流运行中 · 查看 (1)')
    expect(chip).toBeInTheDocument()

    fireEvent.click(chip)

    // Back to run view.
    await waitFor(() => expect(screen.getByText('返回对话')).toBeInTheDocument())
    expect(document.querySelector('#composerInput')).toBeNull()
  })
})
