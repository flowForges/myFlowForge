import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }
]

const wsWithStages = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [
    { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', provider: 'claude', model: 'opus-4.8' },
  ],
  projects: [{ repoId: 'r1', name: 'web', branch: 'feat/cool', provider: 'claude', model: 'opus-4.8' }],
}

const getWorkspaceMock = vi.fn(async () => wsWithStages)
const runWorkspaceMock = vi.fn(async () => {})
const sendChatMock = vi.fn(async () => ({}))

const forgeBase = {
  chatHistory: async () => [], sendChat: sendChatMock, openFiles: async () => [], savePaste: vi.fn(),
  onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
  watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
  gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
  onChangesEvent: () => () => {},
  lastRun: async () => null,
  getWorkspace: getWorkspaceMock,
  runWorkspace: runWorkspaceMock,
}

beforeEach(() => {
  getWorkspaceMock.mockClear()
  runWorkspaceMock.mockClear()
  sendChatMock.mockClear()
  ;(window as any).forge = { ...forgeBase }
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

describe('WorkspaceView LLM 自动识别工作流入口', () => {
  it('does not render manual workflow conversion UI or start a workflow from the inspector', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByTitle('编辑工作流')).toBeInTheDocument())
    expect(screen.queryByText('把这次对话转为工作流')).toBeNull()
    expect(screen.queryByText('发起工作流')).toBeNull()

    // Workflow proposal now comes from the LLM forge_workflow/forge_propose_plan path, not a manual button.
    expect(runWorkspaceMock).not.toHaveBeenCalled()
    expect(sendChatMock).not.toHaveBeenCalled()
  })
})
