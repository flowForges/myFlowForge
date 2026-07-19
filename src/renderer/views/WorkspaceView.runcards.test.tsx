import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatMessage } from '@shared/types'
import type { RunControllerState } from '../../main/run/controller'
import type { RunEvent } from '../../main/run/events'

// Task P3-4: run2 inbox events (gate/auth/question/doubt/failure — see runCards.ts/RunEventCard.tsx)
// get wired into the same in-chat timeline the launch-gate card lives in (WorkspaceView.launchgate.
// test.tsx is the sibling suite for that card, and this file mirrors its mock patterns exactly).
// Resolving an event both dispatches the decision to run2 AND freezes+persists the card in place —
// mirroring confirmLaunchGate's freeze pattern (P1-5), but synchronous rather than promise-gated.

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
]

const wsConfig = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [
    { key: 'design', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', provider: 'claude', model: 'opus-4.8' },
  ],
  projects: [
    { repoId: 'r1', name: 'web', branch: 'feat/cool', provider: 'claude', model: 'opus-4.8' },
  ],
  workflows: [{ id: 'wf1', name: '快速修复', stages: [] }],
}

const conversation: ChatMessage[] = [
  { id: 'm1', who: 'user', text: '做个登录页', ts: '1' } as ChatMessage,
  { id: 'm2', who: 'ai', text: '好的,我先看看现有页面结构', ts: '2' } as ChatMessage,
]

const gateEvent: RunEvent = { id: 'g1', kind: 'gate', stageKey: 'design', body: '设计方案：采用微服务架构' }

function makeRunState(inbox: RunEvent[]): RunControllerState {
  return {
    machine: {
      plan: {
        runId: 'run-1',
        stages: [
          { key: 'design', name: '设计', provider: 'claude', model: 'opus-4.8', scope: 'root', gate: true },
          { key: 'develop', name: '开发', provider: 'claude', model: 'opus-4.8', scope: 'per-project', gate: false },
        ],
      },
      stages: [
        { key: 'design', status: 'awaiting-gate', round: 1 },
        { key: 'develop', status: 'pending', round: 0 },
      ],
      currentIndex: 0,
    },
    inbox,
    feedback: [],
    outcomes: {},
    status: 'awaiting',
    pendingDirective: {},
    liveLanes: {},
    stageTimings: {},
    paused: false,
  }
}

const resolveGateMock = vi.fn()
const resolveLaneMock = vi.fn()
const chatAppendRunCardMock = vi.fn(async (_a: {
  workspacePath: string; sessionId: string; ts: string
  runCard: { id: string; kind: string; stageKey: string; title: string; body?: string; decision: string; at: number; ts: number }
}) => ({}))

const forgeBase = {
  chatHistory: vi.fn(async () => conversation),
  chatAppendLaunchGate: vi.fn(async () => ({})),
  chatAppendRunCard: chatAppendRunCardMock,
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
    getState: vi.fn(async () => makeRunState([gateEvent])),
    onUpdate: (_cb: any) => () => {},
    onLog: (_cb: any) => () => {},
    onQueue: (_cb: any) => () => {},
    resolveGate: resolveGateMock,
    resolveLane: resolveLaneMock,
    addFeedback: vi.fn(),
    editFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    abort: vi.fn(),
    launchInfo: vi.fn(async () => ({ workflows: [], projects: [] })),
    launchStart: vi.fn(async () => ({})),
    startWorkflow: vi.fn(),
  },
}

beforeEach(() => {
  resolveGateMock.mockClear()
  resolveLaneMock.mockClear()
  chatAppendRunCardMock.mockClear()
  ;(window as any).forge = { ...forgeBase }
  ;(window as any).confirm = vi.fn(() => true)
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

describe('WorkspaceView: run2 事件卡挂进对话时间线(+凝固持久化)', () => {
  it('inbox 有 gate 事件 → 时间线出方案门卡(通过/打回本阶段/回退到某阶段)', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    await waitFor(() => expect(screen.getByText('通过')).toBeInTheDocument())
    expect(screen.getByText('打回本阶段')).toBeInTheDocument()
    expect(screen.getByText('回退到某阶段')).toBeInTheDocument()
    expect(screen.getByText('设计方案：采用微服务架构')).toBeInTheDocument()
  })

  it('点通过 → 调 run2.resolveGate(id,{type:"advance"}) 且持久化冻结记录,卡片随即凝固(无 通过 按钮)', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('通过')).toBeInTheDocument())

    fireEvent.click(screen.getByText('通过'))

    // Note: this is the RAW window.forge.run2 bridge mock (see useRun2.ts's resolveGate wrapper),
    // which packages (eventId, decision) into a single { workspacePath, eventId, decision } payload.
    expect(resolveGateMock).toHaveBeenCalledWith({ workspacePath: '/ws', eventId: 'g1', decision: { type: 'advance' } })

    await waitFor(() => expect(chatAppendRunCardMock).toHaveBeenCalledTimes(1))
    const call = chatAppendRunCardMock.mock.calls[0][0]
    expect(call.workspacePath).toBe('/ws')
    expect(call.sessionId).toBe('s-1')
    expect(typeof call.ts).toBe('string')
    expect(call.runCard.id).toBe('g1')
    expect(call.runCard.kind).toBe('gate')
    expect(call.runCard.stageKey).toBe('design')
    expect(call.runCard.title).toBe('设计方案：采用微服务架构')
    expect(call.runCard.decision).toBe('通过')
    expect(typeof call.runCard.at).toBe('number')

    // Card freezes in place: 通过/打回本阶段/回退到某阶段 all disappear, a read-only "决定：通过" record
    // replaces them (same id, same stage).
    await waitFor(() => expect(screen.queryByText('通过')).toBeNull())
    expect(screen.queryByText('打回本阶段')).toBeNull()
    expect(screen.queryByText('回退到某阶段')).toBeNull()
    const card = document.querySelector('[data-req="g1"]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.classList.contains('done')).toBe(true)
    expect(within(card).getByText('决定：通过')).toBeInTheDocument()
  })

  it('重载会话(chatHistory 里带持久化的 runCard 记录)后凝固卡片依旧展示,内容一致', async () => {
    const persisted: ChatMessage[] = [
      ...conversation,
      {
        id: 'g1', who: 'ai', text: '', ts: '2026-07-19T00:00:03.000Z',
        runCard: { id: 'g1', kind: 'gate', stageKey: 'design', title: '设计方案：采用微服务架构', decision: '通过', at: 1752883200000, ts: 1752883100000 },
      } as ChatMessage,
    ]
    ;(window as any).forge = {
      ...forgeBase,
      chatHistory: vi.fn(async () => persisted),
      run2: { ...forgeBase.run2, getState: vi.fn(async () => null) },
    }

    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    const card = await waitFor(() => {
      const el = document.querySelector('[data-req="g1"]') as HTMLElement
      expect(el).toBeTruthy()
      return el
    })
    expect(card.classList.contains('done')).toBe(true)
    expect(within(card).getByText('设计方案：采用微服务架构')).toBeInTheDocument()
    expect(within(card).getByText('决定：通过')).toBeInTheDocument()
    // The underlying synthetic marker message (blank text) doesn't render as a plain bubble — only
    // the two real conversation messages show up as such.
    expect(screen.getByText('做个登录页')).toBeInTheDocument()
    expect(screen.getByText('好的,我先看看现有页面结构')).toBeInTheDocument()
  })
})
