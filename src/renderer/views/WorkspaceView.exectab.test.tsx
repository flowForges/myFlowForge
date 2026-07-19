import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'
import type { RunControllerState } from '../../main/run/controller'

// P2-2: the right inspector gets a new 执行 tab (RunExecPanel) that replaces 概览/代理 while a run2
// run is live (running/awaiting), and is defaulted-to the moment a new run starts. Chat mode (no
// run2 state) keeps the existing 概览|变更|文件树 tab bar untouched.
//
// NOTE: assertions about exec-pane CONTENT are scoped to `#pane-exec` via `within` rather than
// global `screen` queries — a defensive habit kept from when the (now-removed, P2-4) floating
// WorkflowOverlay rendered the same stage names elsewhere on the page.

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
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
      plan: {
        runId: 'run2-1',
        stages: [
          { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus-4.8', scope: 'root', gate: true, prompt: '设计技术方案' },
          { key: 'dev', name: '代码开发', provider: 'claude', model: 'opus-4.8', scope: 'root', gate: false, prompt: '实现代码变更' },
        ],
      },
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
    stageTimings: {},
    paused: false,
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
    pause: vi.fn(),
    resume: vi.fn(),
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

describe('WorkspaceView inspector 执行 tab (P2-2)', () => {
  it('chat mode (no run2 state): 执行 tab absent, normal 概览|变更|文件树 tabs present', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    expect(container.querySelector('.insp-tab[data-pane="exec"]')).toBeNull()
    expect(container.querySelector('.insp-tab[data-pane="agents"]')).not.toBeNull()
    expect(screen.getByText('概览')).toBeInTheDocument()
    expect(container.querySelector('.insp-tab[data-pane="changes"]')).not.toBeNull()
    expect(container.querySelector('.insp-tab[data-pane="files"]')).not.toBeNull()
  })

  it('live run2 state: 执行 tab appears, replaces 概览/代理, and is selected by default', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    act(() => {
      emitRun2Update({ workspacePath: '/ws', state: makeRunState({ status: 'running' }) })
    })

    await waitFor(() => expect(container.querySelector('.insp-tab[data-pane="exec"]')).not.toBeNull())
    expect(container.querySelector('.insp-tab[data-pane="agents"]')).toBeNull()

    // Defaulted to the 执行 tab (its button carries the 'on' class) without any click.
    const execTabBtn = container.querySelector('.insp-tab[data-pane="exec"]')!
    expect(execTabBtn.classList.contains('on')).toBe(true)

    // RunExecPanel content rendered inside #pane-exec. In the 代理-tab style the develop stage
    // surfaces as a `.stage` whose `.stage-name` is 代码开发 (its root agent card reuses the same
    // name, so scope the assertion to the stage header to stay unambiguous).
    const pane = container.querySelector('#pane-exec') as HTMLElement
    expect(within(pane).getByText('代码开发', { selector: '.stage-name' })).toBeInTheDocument()
    expect(within(pane).getByText('已完成 1 / 2')).toBeInTheDocument()
  })

  it('clicking 执行 after navigating away re-selects the RunExecPanel content; mid-run status churn does not force it back', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    act(() => {
      emitRun2Update({ workspacePath: '/ws', state: makeRunState({ status: 'running' }) })
    })
    await waitFor(() => expect(container.querySelector('.insp-tab[data-pane="exec"]')).not.toBeNull())

    // User manually navigates to 变更 mid-run.
    fireEvent.click(container.querySelector('.insp-tab[data-pane="changes"]')!)
    expect(container.querySelector('.insp-tab[data-pane="exec"]')!.classList.contains('on')).toBe(false)
    expect(container.querySelector('.insp-tab[data-pane="changes"]')!.classList.contains('on')).toBe(true)

    // A mere status churn within the SAME run (running -> awaiting) must NOT force the tab back to
    // 执行 (only a brand-new run defaults it — this is keyed off runId, not status).
    act(() => {
      emitRun2Update({ workspacePath: '/ws', state: makeRunState({ status: 'awaiting' }) })
    })
    expect(container.querySelector('.insp-tab[data-pane="changes"]')!.classList.contains('on')).toBe(true)
    expect(container.querySelector('.insp-tab[data-pane="exec"]')!.classList.contains('on')).toBe(false)

    fireEvent.click(container.querySelector('.insp-tab[data-pane="exec"]')!)
    expect(container.querySelector('.insp-tab[data-pane="exec"]')!.classList.contains('on')).toBe(true)
    const pane = container.querySelector('#pane-exec') as HTMLElement
    expect(within(pane).getByText('代码开发', { selector: '.stage-name' })).toBeInTheDocument()
  })

  // Deferred fix (P2-2): the 执行 tab BUTTON used to be gated on run2Live (running/awaiting only) —
  // the instant a run reached ok/failed, the button itself disappeared, stranding a user who'd
  // navigated to 变更/文件树 with no way back to review the finished run (or a merge-failure error).
  // Now gated on the session-scoped run2StateForTab, which stays non-null through ok/failed.
  it('run reaches terminal status (ok/failed, same owning session): 执行 tab stays present/clickable; switching to a session with no run hides it', async () => {
    const twoSessionsFile = (active: string) => ({
      sessions: [
        { id: 's-1', title: '会话一', mode: 'workflow' as const, createdAt: 0 },
        { id: 's-2', title: '会话二', mode: 'chat' as const, createdAt: 1 },
      ],
      activeSessionId: active,
    })
    ;(window as any).forge = {
      ...forgeBase,
      sessionList: vi.fn(async () => twoSessionsFile('s-1')),
      sessionSwitch: vi.fn(async (a: { sessionId: string }) => twoSessionsFile(a.sessionId)),
    }

    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    act(() => {
      emitRun2Update({ workspacePath: '/ws', state: makeRunState({ status: 'running', sessionId: 's-1' }) })
    })
    await waitFor(() => expect(container.querySelector('.insp-tab[data-pane="exec"]')).not.toBeNull())

    // Run finishes: status running -> ok. The tab BUTTON must remain (not just its content).
    act(() => {
      emitRun2Update({ workspacePath: '/ws', state: makeRunState({ status: 'ok', sessionId: 's-1' }) })
    })
    await waitFor(() => expect(container.querySelector('.insp-tab[data-pane="exec"]')).not.toBeNull())

    // Still clickable: navigate away then back, terminal RunExecPanel content still renders.
    fireEvent.click(container.querySelector('.insp-tab[data-pane="changes"]')!)
    expect(container.querySelector('.insp-tab[data-pane="exec"]')!.classList.contains('on')).toBe(false)
    fireEvent.click(container.querySelector('.insp-tab[data-pane="exec"]')!)
    expect(container.querySelector('.insp-tab[data-pane="exec"]')!.classList.contains('on')).toBe(true)
    const pane = container.querySelector('#pane-exec') as HTMLElement
    expect(within(pane).getByText('代码开发', { selector: '.stage-name' })).toBeInTheDocument()

    // Switch to a DIFFERENT session that never ran anything: the tab hides again.
    fireEvent.click(screen.getByText('会话二'))
    await waitFor(() => expect(container.querySelector('.insp-tab[data-pane="agents"]')).not.toBeNull())
    expect(container.querySelector('.insp-tab[data-pane="exec"]')).toBeNull()
  })
})
