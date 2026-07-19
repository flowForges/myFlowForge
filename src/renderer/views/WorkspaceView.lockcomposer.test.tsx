import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'
import type { RunControllerState } from '../../main/run/controller'

// Task P2-3: while a workflow run is active, the chat input box is LOCKED entirely — all gate/decision
// interaction happens via cards, never via the chat input (roots out the old "chat reply vs. gate
// answer" ambiguity). Locked = disabled + placeholder/notice text, driven by the same run2 liveness
// derivation the file already uses for the reopen chip / auto-open (`run2Live`).

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

describe('WorkspaceView: composer locked while a workflow run is active', () => {
  it('no run: composer textarea is enabled (normal)', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    const ta = document.querySelector('#composerInput') as HTMLTextAreaElement
    expect(ta.disabled).toBe(false)
    expect(ta.placeholder).not.toMatch(/执行中/)
  })

  it('run active + stepped back to chat ("返回对话"): composer is disabled and shows the 执行中 notice', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    act(() => {
      emitRun2Update({ workspacePath: '/ws', state: makeRunState({ status: 'running' }) })
    })

    // Run auto-opens the run view (composer hidden); step back to chat to see the locked composer.
    await waitFor(() => expect(screen.getByText('返回对话')).toBeInTheDocument())
    fireEvent.click(screen.getByText('返回对话'))

    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    const ta = document.querySelector('#composerInput') as HTMLTextAreaElement
    expect(ta.disabled).toBe(true)
    expect(ta.placeholder).toMatch(/执行中/)
    expect(ta.placeholder).toMatch(/上方卡片/)

    const sendBtn = document.querySelector('#sendBtn') as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
  })
})
