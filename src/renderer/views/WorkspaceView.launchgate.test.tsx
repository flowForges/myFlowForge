import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatMessage } from '@shared/types'

// Task P1-3: the in-chat LaunchGateCard replaces the floating overlay (WorkflowOverlay, removed
// entirely in P2-4) as the "/开启工作流" trigger's destination. Picking the built-in command (or a
// named workspace-workflow "/" entry) inserts an ACTIVE LaunchGateCard into the chat timeline.
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
const chatAppendLaunchGateMock = vi.fn(async (_a: {
  workspacePath: string; sessionId: string; id: string; ts: string
  workflowName: string; projects: string[]; supplement: string; decidedAt: number; seed: string
}) => ({}))

const forgeBase = {
  chatHistory: vi.fn(async () => conversation),
  chatAppendLaunchGate: chatAppendLaunchGateMock,
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
  launchStartMock.mockImplementation(async () => ({}))
  chatAppendLaunchGateMock.mockClear()
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

// Task P1-5: the frozen record must persist into the session (survive reload/session-switch) and the
// P1-3 follow-up fix — freeze only after run2.start actually resolves, not optimistically before it.
describe('WorkspaceView: 启动门凝固记录持久化 + 仅在 run2.start 成功后才凝固', () => {
  it('确认成功后调用 chatAppendLaunchGate,携带 workflowName/projects/supplement/decidedAt/seed', async () => {
    await openComposerAndPickBuiltin()
    await waitFor(() => expect(screen.getByText('确认')).toBeInTheDocument())

    fireEvent.click(screen.getByText('确认'))

    await waitFor(() => expect(chatAppendLaunchGateMock).toHaveBeenCalledTimes(1))
    const call = chatAppendLaunchGateMock.mock.calls[0][0]
    expect(call.workspacePath).toBe('/ws')
    expect(call.sessionId).toBe('s-1')
    expect(typeof call.id).toBe('string')
    expect(typeof call.ts).toBe('string')
    expect(call.workflowName).toBe('快速修复')
    expect(call.projects).toEqual(['web', 'api'])
    expect(call.supplement).toBe('')
    expect(typeof call.decidedAt).toBe('number')
    expect(call.seed).toBe('我: 做个登录页\n\nAI: 好的,我先看看现有页面结构')

    // Persisted with the same id as the (now frozen) in-chat card.
    await waitFor(() => expect(screen.getByText('工作流已启动')).toBeInTheDocument())
  })

  it('重载会话(chatHistory 里带持久化的 launchGate 记录)后凝固卡片依旧展示,内容一致', async () => {
    const persisted: ChatMessage[] = [
      ...conversation,
      {
        id: 'lg-persisted-1', who: 'ai', text: '', ts: '2026-07-19T00:00:03.000Z',
        launchGate: { workflowName: '快速修复', projects: ['web'], supplement: '记得加测试', decidedAt: 1752883200000, seed: '我: 做个登录页' },
      } as ChatMessage,
    ]
    ;(window as any).forge = { ...forgeBase, chatHistory: vi.fn(async () => persisted) }

    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    // Frozen record renders straight from the reloaded session history — no confirm click needed, and
    // no plain-text bubble for the underlying synthetic marker message (blank text, so nothing to show
    // besides the reconstructed card). Scoped to the launch-gate card itself: "快速修复" also appears
    // elsewhere in the workspace chrome (e.g. the workflow glance panel), so a bare screen query would
    // match more than one element.
    await waitFor(() => expect(screen.getByText('工作流已启动')).toBeInTheDocument())
    const card = document.querySelector('[data-req="launch-gate"]') as HTMLElement
    expect(card).toBeTruthy()
    expect(within(card).getByText('快速修复')).toBeInTheDocument()
    expect(within(card).getByText('涉及项目：web')).toBeInTheDocument()
    expect(within(card).getByText('补充：记得加测试')).toBeInTheDocument()
    // Only the two real conversation bubbles show as plain messages — the marker message doesn't.
    expect(screen.getByText('做个登录页')).toBeInTheDocument()
    expect(screen.getByText('好的,我先看看现有页面结构')).toBeInTheDocument()
  })

  it('run2.launchStart 被拒绝时不凝固、不持久化,卡片保持活态并展示错误', async () => {
    launchStartMock.mockImplementationOnce(async () => { throw new Error('工作流不存在') })
    await openComposerAndPickBuiltin()
    await waitFor(() => expect(screen.getByText('确认')).toBeInTheDocument())

    fireEvent.click(screen.getByText('确认'))

    await waitFor(() => expect(launchStartMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('工作流不存在')).toBeInTheDocument())

    // Still active: 确认 button remains, no frozen "已启动" record, nothing persisted.
    expect(screen.getByText('确认')).toBeInTheDocument()
    expect(screen.queryByText('工作流已启动')).toBeNull()
    expect(chatAppendLaunchGateMock).not.toHaveBeenCalled()
  })

  it('拒绝后重新确认(这次成功)则正常凝固', async () => {
    launchStartMock.mockImplementationOnce(async () => { throw new Error('网络错误') })
    await openComposerAndPickBuiltin()
    await waitFor(() => expect(screen.getByText('确认')).toBeInTheDocument())

    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(screen.getByText('网络错误')).toBeInTheDocument())

    // Retry — the mock's default implementation (reset in beforeEach) resolves this time.
    fireEvent.click(screen.getByText('确认'))

    await waitFor(() => expect(launchStartMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('工作流已启动')).toBeInTheDocument())
    expect(screen.queryByText('网络错误')).toBeNull()
    expect(chatAppendLaunchGateMock).toHaveBeenCalledTimes(1)
  })
})

// Task P1-6: an ACTIVE (unconfirmed) launch gate must be scoped to the session it was opened in.
// `launchGates` is component-level state that does NOT reset on session switch (only frozen/persisted
// gates ride on session-scoped ChatMessages) — before the fix, an active gate opened in session A stayed
// visible in mergedLaunchGates after switching to session B, bleeding across sessions.
describe('WorkspaceView: 活态启动门按会话隔离(不跨会话泄露)', () => {
  it('会话A开启的活态门,切到会话B不可见,切回A重新出现', async () => {
    const sessionsList = [
      { id: 's-1', title: '会话A', mode: 'chat' as const, createdAt: 0 },
      { id: 's-2', title: '会话B', mode: 'chat' as const, createdAt: 0 },
    ]
    const sessionSwitchMock = vi.fn(async ({ sessionId }: { workspacePath: string; sessionId: string }) => ({
      sessions: sessionsList, activeSessionId: sessionId,
    }))
    ;(window as any).forge = {
      ...forgeBase,
      sessionList: vi.fn(async () => ({ sessions: sessionsList, activeSessionId: 's-1' })),
      sessionSwitch: sessionSwitchMock,
    }

    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('做个登录页')).toBeInTheDocument())

    // Open an active launch gate while session A ("会话A") is active.
    const ta = document.querySelector('#composerInput') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/开启工作流' } })
    fireEvent.mouseDown(screen.getByText('开启工作流', { selector: '.slash-title' }))
    await waitFor(() => expect(screen.getByText('确认')).toBeInTheDocument())

    // Switch to session B — the still-active gate from A must NOT show up here.
    fireEvent.click(screen.getByText('会话B'))
    await waitFor(() => expect(sessionSwitchMock).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 's-2' }))
    await waitFor(() => expect(screen.queryByText('确认')).toBeNull())

    // Switch back to session A — the gate reappears (it was never lost, just hidden).
    fireEvent.click(screen.getByText('会话A'))
    await waitFor(() => expect(sessionSwitchMock).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 's-1' }))
    await waitFor(() => expect(screen.getByText('确认')).toBeInTheDocument())
  })
})
