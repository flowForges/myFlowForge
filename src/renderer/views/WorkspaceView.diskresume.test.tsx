import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatMessage } from '@shared/types'

// P-C2/T3 (disk-resume recovery UI): on workspace open, useRun2 calls run2.resumable(ws) — if it
// returns a summary (a workflow was interrupted by a previous app exit/crash and nothing is currently
// driving it — see Run2Manager.resumable's doc), WorkspaceView offers a 继续/丢弃 prompt. Never
// auto-resumes.

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
]

const wsConfig = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [{ key: 'requirement', provider: 'claude', model: 'opus-4.8' }],
  projects: [{ repoId: 'r1', name: 'web', branch: 'feat/cool', provider: 'claude', model: 'opus-4.8' }],
  workflows: [{ id: 'wf1', name: '快速修复', stages: [] }],
}

const conversation: ChatMessage[] = [
  { id: 'm1', who: 'user', text: '做个登录页', ts: '1' } as ChatMessage,
]

const resumableSummary = {
  runId: 'run-x', resumeStageKey: 'develop', resumeStageName: '开发', totalStages: 3, doneCount: 1,
}

const resumableMock = vi.fn(async () => null as typeof resumableSummary | null)
const resumeFromDiskMock = vi.fn(async () => ({}))
const discardResumableMock = vi.fn(async () => true)

const forgeBase = {
  chatHistory: vi.fn(async () => conversation),
  chatAppendLaunchGate: vi.fn(async () => ({})),
  chatAppendRunCard: vi.fn(async () => ({})),
  sendChat: vi.fn(async () => ({})), openFiles: async () => [], savePaste: vi.fn(),
  onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
  sessionList: async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }),
  sessionSwitch: vi.fn(), sessionNew: vi.fn(), sessionClose: vi.fn(), sessionRename: vi.fn(),
  watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
  gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
  onChangesEvent: () => () => {},
  changesMulti: vi.fn(async () => ({ total: 0, byProject: [] })),
  lastRun: async () => null,
  getWorkspace: vi.fn(async () => wsConfig),
  runWorkspace: vi.fn(async () => {}),
  commandsList: vi.fn(async () => []),
  run2: {
    getState: vi.fn(async () => null),
    onUpdate: (_cb: any) => () => {},
    onLog: (_cb: any) => () => {},
    onQueue: (_cb: any) => () => {},
    resolveGate: vi.fn(),
    resolveLane: vi.fn(),
    addFeedback: vi.fn(),
    editFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    abort: vi.fn(),
    launchInfo: vi.fn(async () => ({ workflows: [], projects: [] })),
    launchStart: vi.fn(async () => ({})),
    startWorkflow: vi.fn(),
    resumable: resumableMock,
    resumeFromDisk: resumeFromDiskMock,
    discardResumable: discardResumableMock,
  },
}

beforeEach(() => {
  resumableMock.mockClear()
  resumeFromDiskMock.mockClear()
  discardResumableMock.mockClear()
  resumableMock.mockImplementation(async () => null)
  ;(window as any).forge = { ...forgeBase, run2: { ...forgeBase.run2 } }
  ;(window as any).confirm = vi.fn(() => true)
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

describe('WorkspaceView: disk-resume 恢复提示 (P-C2/T3)', () => {
  it('resumable() 返回摘要时,显示继续/丢弃提示,文案含阶段名', async () => {
    resumableMock.mockImplementation(async () => resumableSummary)
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)

    await waitFor(() => expect(resumableMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(screen.getByText('继续')).toBeInTheDocument())
    expect(screen.getByText(/上次有工作流未完成/)).toBeInTheDocument()
    expect(screen.getByText(/开发/)).toBeInTheDocument()
    expect(screen.getByText('丢弃')).toBeInTheDocument()
  })

  it('resumable() 返回 null 时,不显示提示', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(resumableMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    expect(screen.queryByText(/上次有工作流未完成/)).toBeNull()
  })

  it('点击继续调用 run2.resumeFromDisk 并隐藏提示', async () => {
    resumableMock.mockImplementation(async () => resumableSummary)
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('继续')).toBeInTheDocument())

    fireEvent.click(screen.getByText('继续'))

    await waitFor(() => expect(resumeFromDiskMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(screen.queryByText(/上次有工作流未完成/)).toBeNull())
    expect(discardResumableMock).not.toHaveBeenCalled()
  })

  it('点击丢弃调用 run2.discardResumable 并隐藏提示', async () => {
    resumableMock.mockImplementation(async () => resumableSummary)
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('丢弃')).toBeInTheDocument())

    fireEvent.click(screen.getByText('丢弃'))

    await waitFor(() => expect(discardResumableMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(screen.queryByText(/上次有工作流未完成/)).toBeNull())
    expect(resumeFromDiskMock).not.toHaveBeenCalled()
  })
})
