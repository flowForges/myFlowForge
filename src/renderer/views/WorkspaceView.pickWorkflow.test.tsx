import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView, buildConversationSeed } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatMessage } from '@shared/types'

// Task 2: picking a workflow "/" command in the composer used to just stuff a dead trigger phrase
// into the composer (vestigial since P4-B made chat never trigger workflows). It should instead open
// the run2 launcher, preselecting the picked workflow and prefilling the seed with the current
// conversation transcript.

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

const launchInfoMock = vi.fn(async () => ({ workflows: [{ id: 'wf1', name: '快速修复' }], projects: [] }))

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

describe('WorkspaceView: workflow "/" command opens the launcher seeded with the conversation', () => {
  it('picking a workspace-workflow "/" command opens run view with the RunLauncher preselecting the workflow and prefilled with the conversation transcript', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    // Conversation loaded into chat.messages.
    await waitFor(() => expect(screen.getByText('做个登录页')).toBeInTheDocument())

    const ta = document.querySelector('#composerInput') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/快速' } })
    fireEvent.mouseDown(screen.getByText('快速修复', { selector: '.slash-title' }))

    // Run view opens (chat column's composer unmounts).
    await waitFor(() => expect(screen.getByText('返回对话')).toBeInTheDocument())
    expect(document.querySelector('#composerInput')).toBeNull()

    // RunLauncher mounted, preselecting wf1 + prefilled with the conversation transcript.
    await waitFor(() => expect(launchInfoMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.getAllByText('快速修复').length).toBeGreaterThan(0))
    const seedTa = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(seedTa.value).toBe('我: 做个登录页\n\nAI: 好的,我先看看现有页面结构')
  })
})
