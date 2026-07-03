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

const fsTree = vi.fn(async () => [{ type: 'dir', name: '.github', path: '.github', children: [] }])

beforeEach(() => {
  fsTree.mockClear()
  ;(window as any).forge = {
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(),
    onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree,
    gitDiff: vi.fn(async () => []), gitFile: async () => ({ text: 'x', lang: 'ts' }),
    onChangesEvent: () => () => {}, changesMulti: async () => ({ total: 0, add: 0, del: 0, byProject: [] }),
    getWorkspace: async () => ({ name: 'ws', path: '/ws', workflowId: 'standard', stages: [], projects: [], status: 'run' }),
  }
})

describe('WorkspaceView 全部项目 文件树 aggregate mode', () => {
  it('clicks 文件树 tab and renders workspace-root tree via fsTree', async () => {
    render(<WorkspaceView engine={engine} providers={providers} />)
    fireEvent.click(screen.getByText('文件树'))
    await waitFor(() => expect(screen.getByText('.github')).toBeInTheDocument())
    expect(fsTree).toHaveBeenCalledWith('/ws')
  })
})
