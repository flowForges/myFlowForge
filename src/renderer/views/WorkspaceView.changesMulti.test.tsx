import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]
const engine: EngineApi = {
  run: {
    id: 'r', workspaceName: 'ws', workspacePath: '/ws',
    projects: [{ name: 'go-blog', cwd: '/ws/go-blog' }, { name: 'zgh', cwd: '/ws/zgh' }],
    status: 'run', stages: [], pending: [],
  },
  pending: [], resolve: () => {}, cancel: () => {}
}

const changesMulti = vi.fn(async () => ({
  total: 2, add: 11, del: 0,
  byProject: [
    { cwd: '/ws/go-blog', changes: [{ path: 'main.go', type: 'M', add: 6, del: 0 }] },
    { cwd: '/ws/zgh', changes: [{ path: 'index.ts', type: 'A', add: 5, del: 0 }] },
  ],
}))
const gitDiff = vi.fn(async () => [{ kind: 'add', ln: 1, text: 'x' }])

beforeEach(() => {
  changesMulti.mockClear(); gitDiff.mockClear()
  ;(window as any).forge = {
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(),
    onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
    gitDiff, gitFile: async () => ({ text: 'x', lang: 'ts' }),
    onChangesEvent: () => () => {}, changesMulti,
    getWorkspace: async () => ({ name: 'ws', path: '/ws', workflowId: 'standard', stages: [], projects: [], status: 'run' }),
  }
})

describe('WorkspaceView 全部项目 aggregation', () => {
  it('defaults to 全部项目 and renders grouped changes from changesMulti', async () => {
    render(<WorkspaceView engine={engine} providers={providers} />)
    fireEvent.click(screen.getByText('变更'))
    await waitFor(() => expect(screen.getByText('main.go')).toBeInTheDocument())
    expect(screen.getByText('index.ts')).toBeInTheDocument()
    // group headers (per project) are rendered, distinct from the picker <option>s
    expect(document.querySelectorAll('.chg-group-h').length).toBe(2)
    expect(changesMulti).toHaveBeenCalledWith(['/ws/go-blog', '/ws/zgh'])
  })

  it('clicking a file opens preview against that group cwd', async () => {
    render(<WorkspaceView engine={engine} providers={providers} />)
    fireEvent.click(screen.getByText('变更'))
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    fireEvent.click(screen.getByText('index.ts'))
    await waitFor(() => expect(gitDiff).toHaveBeenCalledWith('/ws/zgh', 'index.ts'))
  })
})
