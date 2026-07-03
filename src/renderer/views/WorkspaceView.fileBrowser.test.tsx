import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, TreeNode } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }
]
const ws = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }],
  projects: [{ repoId: 'r1', name: 'web', branch: 'feat/cool', provider: 'claude', model: 'opus-4.8' }],
}
const tree: TreeNode[] = [{ name: 'a.ts', path: 'a.ts', type: 'file', chg: 'M' }]

beforeEach(() => {
  ;(window as any).forge = {
    chatHistory: async () => [], sendChat: vi.fn(async () => ({})), openFiles: async () => [], savePaste: vi.fn(),
    onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    sessionList: async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }),
    sessionSwitch: vi.fn(), sessionNew: vi.fn(), sessionClose: vi.fn(), sessionRename: vi.fn(),
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => tree,
    gitDiff: async () => [{ kind: 'add', ln: 1, text: 'hello' }], gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {}, lastRun: async () => null,
    getWorkspace: vi.fn(async () => ws), runWorkspace: vi.fn(async () => {}),
  }
  ;(window as any).confirm = vi.fn(() => true)
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

describe('WorkspaceView — 文件树 opens the full-screen file browser', () => {
  it('clicking a file in the 文件树 tab opens the overlay; 关闭 dismisses it', async () => {
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    // switch to the 文件树 tab
    fireEvent.click(screen.getByText('文件树'))
    // the tree file streams in from fsTree
    const fileRow = await screen.findByText('a.ts')
    // no overlay yet
    expect(container.querySelector('.file-browser')).toBeNull()
    // clicking the file opens the full-screen browser
    fireEvent.click(fileRow)
    await waitFor(() => expect(container.querySelector('.file-browser')).not.toBeNull())
    expect(screen.getByText('文件浏览')).toBeInTheDocument()
    // closing returns to the workspace
    fireEvent.click(screen.getByLabelText('关闭文件浏览'))
    await waitFor(() => expect(container.querySelector('.file-browser')).toBeNull())
  })
})
