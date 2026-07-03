import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }
]

// Workspace with TWO projects — enough to trigger ProjectPicker (it only renders when >1 project)
const wsWithTwoProjects = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [
    { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
  ],
  projects: [
    { repoId: 'r1', name: 'proj-a', branch: 'main', provider: 'claude', model: 'opus-4.8' },
    { repoId: 'r2', name: 'proj-b', branch: 'main', provider: 'claude', model: 'opus-4.8' },
  ],
}

const changesMultiMock = vi.fn(async (_cwds: string[]) => ({ total: 0, byProject: [] }))
const getWorkspaceMock = vi.fn(async () => wsWithTwoProjects)

const forgeBase = {
  chatHistory: async () => [], sendChat: vi.fn(async () => ({})), openFiles: async () => [], savePaste: vi.fn(),
  onChatEvent: (_cb: any) => () => {}, onChatQueueEvent: () => () => {},
  sessionList: async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }),
  sessionSwitch: vi.fn(), sessionNew: vi.fn(), sessionClose: vi.fn(), sessionRename: vi.fn(),
  watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
  gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
  onChangesEvent: () => () => {},
  lastRun: async () => null,
  getWorkspace: getWorkspaceMock,
  runWorkspace: vi.fn(async () => {}),
  changesMulti: changesMultiMock,
}

beforeEach(() => {
  getWorkspaceMock.mockClear()
  changesMultiMock.mockClear()
  ;(window as any).forge = { ...forgeBase }
  ;(window as any).confirm = vi.fn(() => true)
})

// No live run → chat mode
const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

describe('WorkspaceView chat mode 变更/文件树 sourced from workspace config', () => {
  it('ProjectPicker renders workspace project names in chat mode (no live run)', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)

    // Wait for workspace info to load (wsInfo is async)
    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledWith('/ws'))

    // Switch the inspector to 变更 tab
    const changesTab = screen.getByText('变更')
    fireEvent.click(changesTab)

    // ProjectPicker renders a <select> with proj-a and proj-b options when >1 project
    // — this only happens if projects comes from wsInfo (since run is null → run.projects = [])
    await waitFor(() => {
      const select = document.querySelector('.insp-proj select') as HTMLSelectElement | null
      expect(select).not.toBeNull()
    })

    const select = document.querySelector('.insp-proj select') as HTMLSelectElement
    const optionTexts = Array.from(select.options).map(o => o.text)
    expect(optionTexts).toContain('proj-a')
    expect(optionTexts).toContain('proj-b')
  })

  it('changesMulti is called with ws-derived cwds (/ws/proj-a, /ws/proj-b) in chat mode', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)

    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledWith('/ws'))

    // Switch to 变更 tab to trigger aggregate mode
    fireEvent.click(screen.getByText('变更'))

    // changesMulti should be called with the workspace-derived cwds
    await waitFor(() => expect(changesMultiMock).toHaveBeenCalled())
    const [cwds] = changesMultiMock.mock.calls[0]
    expect(cwds).toContain('/ws/proj-a')
    expect(cwds).toContain('/ws/proj-b')
  })
})
