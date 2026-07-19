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

function makeRunState(inbox: RunEvent[], sessionId?: string): RunControllerState {
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
    sessionId,
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

// Deferred Minor fix: run2 interaction cards must be scoped to the session that STARTED the run
// (spec §8 — "一次 run 绑定到发起它的会话"), mirroring the old orchestrator's engine.run.sessionId
// gating (WorkspaceView.tsx ~line 279-281). Before this fix, cards derived unconditionally from
// run2.state.inbox and showed up in whichever tab happened to be in front.
describe('WorkspaceView: run2 事件卡按发起会话隔离', () => {
  const twoSessionsFile = (active: string) => ({
    sessions: [
      { id: 's-A', title: '会话A', mode: 'workflow' as const, createdAt: 0 },
      { id: 's-B', title: '会话B', mode: 'chat' as const, createdAt: 1 },
    ],
    activeSessionId: active,
  })
  const histories: Record<string, ChatMessage[]> = {
    's-A': [{ id: 'a1', who: 'user', text: '会话A的历史', ts: '1' } as ChatMessage],
    's-B': [{ id: 'b1', who: 'user', text: '会话B的历史', ts: '1' } as ChatMessage],
  }

  function twoSessionForge(runSessionId: string | undefined, inbox: RunEvent[] = [gateEvent]) {
    return {
      ...forgeBase,
      chatHistory: vi.fn(async (_ws: string, sid: string) => histories[sid] ?? []),
      sessionList: vi.fn(async () => twoSessionsFile('s-A')),
      sessionSwitch: vi.fn(async (a: { sessionId: string }) => twoSessionsFile(a.sessionId)),
      run2: { ...forgeBase.run2, getState: vi.fn(async () => makeRunState(inbox, runSessionId)) },
    }
  }

  it('run 的 sessionId 是 s-A：在 s-A 展示方案门卡，切到 s-B 后卡片消失，切回 s-A 后重新出现', async () => {
    ;(window as any).forge = twoSessionForge('s-A')
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    // Starts on s-A (the run's owning session) — card visible.
    await waitFor(() => expect(screen.getByText('设计方案：采用微服务架构')).toBeInTheDocument())

    // Switch to s-B: the run belongs to s-A, so its gate card must NOT show here.
    fireEvent.click(screen.getByText('会话B'))
    await waitFor(() => expect(screen.getByText('会话B的历史')).toBeInTheDocument())
    expect(screen.queryByText('设计方案：采用微服务架构')).toBeNull()

    // Switch back to s-A: the card reappears.
    fireEvent.click(screen.getByText('会话A'))
    await waitFor(() => expect(screen.getByText('设计方案：采用微服务架构')).toBeInTheDocument())
  })

  it('run 无 sessionId(legacy)：任意会话都展示方案门卡', async () => {
    ;(window as any).forge = twoSessionForge(undefined)
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('设计方案：采用微服务架构')).toBeInTheDocument())

    // Switch to s-B: a legacy (no-sessionId) run's card shows anywhere in the workspace.
    fireEvent.click(screen.getByText('会话B'))
    await waitFor(() => expect(screen.getByText('会话B的历史')).toBeInTheDocument())
    expect(screen.getByText('设计方案：采用微服务架构')).toBeInTheDocument()
  })

  it('freezeRunCard 把冻结记录持久化到 run 的发起会话(run2.state.sessionId)，而非当前 activeSessionId', async () => {
    ;(window as any).forge = twoSessionForge('s-A')
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('通过')).toBeInTheDocument())

    fireEvent.click(screen.getByText('通过'))

    await waitFor(() => expect(chatAppendRunCardMock).toHaveBeenCalledTimes(1))
    // Currently-active session (s-A) IS the run's owning session in this scenario — asserts the
    // persisted record is keyed off run2.state.sessionId, not just "whatever's active right now".
    expect(chatAppendRunCardMock.mock.calls[0][0].sessionId).toBe('s-A')
  })
})

// Deferred Minor fix (P4-3): RunExecPanel's 终止 button used to call run2.abort() directly — the
// controller force-settles (drops) any pending gate/auth/question/doubt/failure inbox event without
// ever routing through onRunGate/onRunLane's freeze-and-persist path, so whatever card was pending
// just vanished from the chat timeline with no trace. Now WorkspaceView wires an onAbort into
// RunExecPanel that persists a single frozen "运行已终止" marker (same freezeRunCard mechanism, owning-
// session-scoped) BEFORE calling run2.abort().
describe('WorkspaceView: 终止运行 leaves a frozen "运行已终止" record in the owning session', () => {
  it('clicking 终止 persists exactly one record; a repeat click or a later reload does not double-write', async () => {
    const abortMock = vi.fn()
    ;(window as any).forge = {
      ...forgeBase,
      run2: { ...forgeBase.run2, abort: abortMock, getState: vi.fn(async () => makeRunState([gateEvent], 's-1')) },
    }

    const { unmount } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())

    // A running run2 state auto-defaults the right inspector to the 执行 tab (P2-2), so RunExecPanel
    // (and its 终止 button) is already on-screen without any manual tab click. `#pane-exec` itself is
    // always mounted (only its CONTENT is conditional on activeTab==='exec'), so wait for the button
    // specifically rather than just the pane div existing.
    await waitFor(() => {
      const el = document.querySelector('#pane-exec') as HTMLElement
      expect(within(el).queryByRole('button', { name: /终止/ })).toBeTruthy()
    })
    const pane = document.querySelector('#pane-exec') as HTMLElement
    const abortBtn = within(pane).getByRole('button', { name: /终止/ })

    fireEvent.click(abortBtn)
    expect(abortMock).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(chatAppendRunCardMock).toHaveBeenCalledTimes(1))
    const call = chatAppendRunCardMock.mock.calls[0][0]
    expect(call.workspacePath).toBe('/ws')
    expect(call.sessionId).toBe('s-1')
    expect(call.runCard.id).toBe('abort-run-1')
    expect(call.runCard.kind).toBe('aborted')
    expect(call.runCard.stageKey).toBe('design')
    expect(call.runCard.decision).toBe('用户终止运行')
    expect(typeof call.runCard.at).toBe('number')

    // A second click (e.g. before the button visually disappears) must NOT double-write the record,
    // even though it does still forward the abort itself every time.
    fireEvent.click(abortBtn)
    expect(abortMock).toHaveBeenCalledTimes(2)
    expect(chatAppendRunCardMock).toHaveBeenCalledTimes(1)

    unmount()

    // "Reload": a fresh mount that already has the persisted marker in chatHistory (mirrors the
    // sibling reload test above) and a finished/gone run2 state — must NOT re-append on mount.
    chatAppendRunCardMock.mockClear()
    const persisted: ChatMessage[] = [
      ...conversation,
      {
        id: 'abort-run-1', who: 'ai', text: '', ts: '2026-07-19T00:00:03.000Z',
        runCard: { id: 'abort-run-1', kind: 'aborted', stageKey: 'design', title: '运行已终止', decision: '用户终止运行', at: 1752883200000, ts: 1752883200000 },
      } as ChatMessage,
    ]
    ;(window as any).forge = {
      ...forgeBase,
      chatHistory: vi.fn(async () => persisted),
      run2: { ...forgeBase.run2, getState: vi.fn(async () => null) },
    }
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    await waitFor(() => expect(document.querySelector('[data-req="abort-run-1"]')).toBeTruthy())
    expect(chatAppendRunCardMock).not.toHaveBeenCalled()
  })
})
