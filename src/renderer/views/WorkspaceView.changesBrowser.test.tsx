import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo } from '@shared/types'

// 变更 pane 点击文件 → 全屏 overlay 大预览(默认 diff),左栏是变更清单(不是文件树),方便连续点选。

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
const gitDiff = vi.fn(async () => [{ kind: 'add', ln: 1, text: 'diffline' }])

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

describe('WorkspaceView — 变更 pane opens the full-screen browser with a changes sidebar', () => {
  it('clicking a change opens the overlay: left column is the changes list, preview diffs against the group cwd', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} />)
    fireEvent.click(screen.getByText('变更'))
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    expect(container.querySelector('.file-browser')).toBeNull()

    fireEvent.click(screen.getByText('index.ts'))
    await waitFor(() => expect(container.querySelector('.file-browser')).not.toBeNull())
    // left column shows the changes list (for continuous picking), not the file tree
    expect(container.querySelector('.file-browser .chg-item')).not.toBeNull()
    expect(container.querySelector('.file-browser .tree-row')).toBeNull()
    // the clicked row is highlighted
    const on = container.querySelector('.file-browser .chg-item.on')
    expect(on).not.toBeNull()
    expect(on!.getAttribute('data-file')).toBe('index.ts')
    // preview loads the diff against the file's own group cwd (default diff mode)
    await waitFor(() => expect(gitDiff).toHaveBeenCalledWith('/ws/zgh', 'index.ts'))

    // continuous picking: clicking another file in the overlay switches the preview
    fireEvent.click(container.querySelector('.file-browser .chg-item[data-file="main.go"]')!)
    await waitFor(() => expect(gitDiff).toHaveBeenCalledWith('/ws/go-blog', 'main.go'))
    expect(container.querySelector('.file-browser .chg-item.on')!.getAttribute('data-file')).toBe('main.go')

    // 关闭 dismisses the overlay
    fireEvent.click(screen.getByLabelText('关闭文件浏览'))
    await waitFor(() => expect(container.querySelector('.file-browser')).toBeNull())
  })
})
