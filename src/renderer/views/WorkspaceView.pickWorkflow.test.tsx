import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView, buildConversationSeed } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatMessage } from '@shared/types'

// Task 2: picking a workflow "/" command in the composer used to just stuff a dead trigger phrase
// into the composer (vestigial since P4-B made chat never trigger workflows).
// P1-3: it now inserts an in-chat LaunchGateCard (preselecting the picked workflow, prefilled with
// the current conversation transcript as its read-only seed) instead of opening the floating
// WorkflowOverlay (removed entirely in P2-4) — see WorkspaceView.launchgate.test.tsx for the fuller
// confirm/freeze coverage.

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
  workflows: [{ id: 'wf1', name: '快速修复', stages: [] }],
}

const conversation: ChatMessage[] = [
  { id: 'm1', who: 'user', text: '做个登录页', ts: '1' } as ChatMessage,
  { id: 'm2', who: 'ai', text: '好的,我先看看现有页面结构', ts: '2' } as ChatMessage,
]

const launchInfoMock = vi.fn(async () => ({ workflows: [{ id: 'wf1', name: '快速修复', stages: [] }], projects: [] }))

const forgeBase = {
  chatHistory: vi.fn(async () => conversation),
  sendChat: vi.fn(async () => ({})), openFiles: async () => [], savePaste: vi.fn(),
  onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
  sessionList: async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }),
  sessionSwitch: vi.fn(), sessionNew: vi.fn(), sessionClose: vi.fn(), sessionRename: vi.fn(),
  watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
  gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
  onChangesEvent: () => () => {},
  lastRun: async () => null,
  getWorkspace: vi.fn(async () => wsConfig),
  runWorkspace: vi.fn(async () => {}),
  commandsList: vi.fn(async () => []),
  run2: {
    getState: vi.fn(async () => null),
    onUpdate: (_cb: any) => () => {},
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
  launchInfoMock.mockClear()
  ;(window as any).forge = { ...forgeBase }
  ;(window as any).confirm = vi.fn(() => true)
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

describe('buildConversationSeed (pure)', () => {
  it('turns messages into a "我/AI" transcript', () => {
    expect(buildConversationSeed(conversation)).toBe(
      '我: 做个登录页\n\nAI: 好的,我先看看现有页面结构',
    )
  })

  it('returns "" for an empty conversation', () => {
    expect(buildConversationSeed([])).toBe('')
  })
})

describe('WorkspaceView: workflow "/" command inserts an in-chat LaunchGateCard seeded with the conversation', () => {
  it('picking a workspace-workflow "/" command stays in chat, showing a LaunchGateCard preselecting the workflow and prefilled with the conversation transcript', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    // Conversation loaded into chat.messages.
    await waitFor(() => expect(screen.getByText('做个登录页')).toBeInTheDocument())

    const ta = document.querySelector('#composerInput') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/快速' } })
    fireEvent.mouseDown(screen.getByText('快速修复', { selector: '.slash-title' }))

    // Stays in chat — composer remains mounted, no "返回对话"/floating overlay.
    await waitFor(() => expect(launchInfoMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('确认')).toBeInTheDocument())
    expect(document.querySelector('#composerInput')).toBeInTheDocument()
    expect(screen.queryByText('返回对话')).toBeNull()

    // LaunchGateCard mounted, preselecting wf1 (its tab shows "on") + prefilled seed = conversation transcript.
    // Scoped to .wfo-tab — "快速修复" (the workflow name) can also appear elsewhere on the page (e.g.
    // the inspector's workflow glance), so a bare screen.getByText would match more than one element.
    const tab = Array.from(document.querySelectorAll('.wfo-tab')).find((el) => el.textContent?.includes('快速修复'))
    expect(tab).toHaveClass('on')
    const seedEl = document.querySelector('[data-req="launch-gate"] .req-sub')
    expect(seedEl?.textContent).toBe('我: 做个登录页\n\nAI: 好的,我先看看现有页面结构')
  })

  it('renders the in-chat LaunchGateCard, not WorkflowOverlay (.wfo) or the old RunLauncher', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('做个登录页')).toBeInTheDocument())

    const ta = document.querySelector('#composerInput') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/快速' } })
    fireEvent.mouseDown(screen.getByText('快速修复', { selector: '.slash-title' }))

    await waitFor(() => expect(launchInfoMock).toHaveBeenCalled())
    await waitFor(() => expect(document.querySelector('[data-req="launch-gate"]')).toBeInTheDocument())
    expect(document.querySelector('.wfo')).toBeNull()
    expect(document.querySelector('.run-launcher')).toBeNull()
  })
})
