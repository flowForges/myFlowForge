import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatMessage } from '@shared/types'

// Task P1-3: the in-chat LaunchGateCard replaces the floating overlay as the "/开启工作流" trigger's
// destination. Picking the built-in command (or a named workspace-workflow "/" entry) now inserts an
// ACTIVE LaunchGateCard into the chat timeline instead of opening WorkflowOverlay via setRunView(true).
// Confirming calls run2.launchStart with only the selected projects, then freezes the card in place.

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
]

const wsConfig = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [
    { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', provider: 'claude', model: 'opus-4.8' },
  ],
  projects: [
    { repoId: 'r1', name: 'web', branch: 'feat/cool', provider: 'claude', model: 'opus-4.8' },
    { repoId: 'r2', name: 'api', branch: 'feat/cool', provider: 'codex', model: 'gpt-5-codex' },
  ],
  workflows: [{ id: 'wf1', name: '快速修复', stages: [] }],
}

const conversation: ChatMessage[] = [
  { id: 'm1', who: 'user', text: '做个登录页', ts: '1' } as ChatMessage,
  { id: 'm2', who: 'ai', text: '好的,我先看看现有页面结构', ts: '2' } as ChatMessage,
]

const launchInfoMock = vi.fn(async () => ({
  workflows: [{ id: 'wf1', name: '快速修复', stages: [] }],
  projects: [
    { name: 'web', cwd: '/ws/web', provider: 'claude', model: 'opus-4.8' },
    { name: 'api', cwd: '/ws/api', provider: 'codex', model: 'gpt-5-codex' },
  ],
}))
const launchStartMock = vi.fn(async (_cfg: {
  workspacePath: string; workflowId: string
  projects: { name: string; provider: string; model: string }[]
  supplement: string; seed: string
}) => ({}))

const forgeBase = {
  chatHistory: vi.fn(async () => conversation),
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
    launchInfo: launchInfoMock,
    launchStart: launchStartMock,
    startWorkflow: vi.fn(),
  },
}

beforeEach(() => {
  launchInfoMock.mockClear()
  launchStartMock.mockClear()
  ;(window as any).forge = { ...forgeBase }
  ;(window as any).confirm = vi.fn(() => true)
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

async function openComposerAndPickBuiltin() {
  render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
  await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
  await waitFor(() => expect(screen.getByText('做个登录页')).toBeInTheDocument())

  const ta = document.querySelector('#composerInput') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: '/开启工作流' } })
  fireEvent.mouseDown(screen.getByText('开启工作流', { selector: '.slash-title' }))
}

describe('WorkspaceView: 启动门在对话时间线内(触发/凝固)', () => {
  it('/开启工作流 在对话区插入 LaunchGateCard(活态),不打开浮层', async () => {
    await openComposerAndPickBuiltin()

    await waitFor(() => expect(launchInfoMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('确认')).toBeInTheDocument())

    // Stays in chat — composer is still mounted, the floating overlay does NOT open.
    expect(document.querySelector('#composerInput')).toBeInTheDocument()
    expect(screen.queryByText('返回对话')).toBeNull()
    expect(document.querySelector('.wfo')).toBeNull()
  })

  it('确认后调用 run2.launchStart(只含已选项目) 且卡片变凝固', async () => {
    await openComposerAndPickBuiltin()
    await waitFor(() => expect(screen.getByText('确认')).toBeInTheDocument())

    // Deselect the "api" project before confirming — only "web" should be sent. Scoped to the
    // launch-gate card's project rows (the workspace header elsewhere also renders "api" as a
    // project name, so a bare screen.getByText('api') matches more than one element).
    const apiRow = Array.from(document.querySelectorAll('.wfo-proj')).find((el) => el.textContent?.includes('api'))!
    fireEvent.click(apiRow.querySelector('.wfo-ckhit')!)

    fireEvent.click(screen.getByText('确认'))

    await waitFor(() => expect(launchStartMock).toHaveBeenCalledTimes(1))
    const cfg = launchStartMock.mock.calls[0][0]
    expect(cfg.workspacePath).toBe('/ws')
    expect(cfg.workflowId).toBe('wf1')
    expect(cfg.projects).toEqual([{ name: 'web', provider: 'claude', model: 'opus-4.8' }])
    expect(cfg.supplement).toBe('')
    expect(cfg.seed).toBe('我: 做个登录页\n\nAI: 好的,我先看看现有页面结构')

    // Card freezes: 确认 button disappears, a read-only "已启动" record replaces it.
    await waitFor(() => expect(screen.queryByText('确认')).toBeNull())
    expect(screen.getByText('工作流已启动')).toBeInTheDocument()
  })
})
