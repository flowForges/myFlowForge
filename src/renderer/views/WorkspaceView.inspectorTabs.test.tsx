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

const forgeBase = {
  chatHistory: async () => [], sendChat: vi.fn(async () => ({})), openFiles: async () => [], savePaste: vi.fn(),
  onChatEvent: (cb: any) => { return () => {} }, onChatQueueEvent: () => () => {},
  sessionList: async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }),
  sessionSwitch: vi.fn(), sessionNew: vi.fn(), sessionClose: vi.fn(), sessionRename: vi.fn(),
  watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
  gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
  onChangesEvent: () => () => {},
  lastRun: async () => null,
  getWorkspace: vi.fn(async () => wsWithStages),
  runWorkspace: vi.fn(async () => {}),
}

beforeEach(() => {
  ;(window as any).forge = { ...forgeBase }
  ;(window as any).confirm = vi.fn(() => true)
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }
const liveEngine: EngineApi = {
  run: { id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run', projects: [], stages: [], pending: [] },
  pending: [], resolve: () => {}, cancel: () => {}
}

describe('WorkspaceView inspector tabs always visible', () => {
  it('chat mode: 变更 and 文件树 tabs are present, first tab label is 概览, #mainChat exists, aside has chat class', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    const aside = container.querySelector('aside.inspector')!
    await waitFor(() => expect(aside.classList.contains('chat')).toBe(true))
    // Tab bar always present
    expect(screen.getByText('变更')).toBeInTheDocument()
    expect(screen.getByText('文件树')).toBeInTheDocument()
    // First tab label changes to 概览 in chat mode
    expect(screen.getByText('概览')).toBeInTheDocument()
    // #mainChat is present in the DOM (CSS hides #mainFlow, shows #mainChat)
    expect(container.querySelector('#mainChat')).not.toBeNull()
    expect(container.querySelector('#mainFlow')).not.toBeNull()
  })

  it('workflow mode: first tab label is 代理, all three tabs present, #mainFlow exists, aside has no chat class', async () => {
    const { container } = render(<WorkspaceView engine={liveEngine} providers={providers} workspacePath="/ws" />)
    const aside = container.querySelector('aside.inspector')!
    expect(aside.classList.contains('chat')).toBe(false)
    // First tab label is 代理 in workflow mode
    expect(screen.getByText('代理')).toBeInTheDocument()
    expect(screen.getByText('变更')).toBeInTheDocument()
    expect(screen.getByText('文件树')).toBeInTheDocument()
    // #mainFlow is present
    expect(container.querySelector('#mainFlow')).not.toBeNull()
  })
})
