import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, RunState } from '@shared/types'

// Production shape: the legacy engine is an inert stub (run === null), so the inspector's project
// list comes from the workspace config (wsInfo.projects) — here two projects, like a real
// multi-project workspace whose root is not a git repo.
const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]
const idle: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

const wsInfo = (path: string) => ({
  name: path.slice(1), path, workflowId: 'standard', stages: [], status: 'idle',
  projects: [{ repoId: 'go-blog', name: 'go-blog' }, { repoId: 'zgh', name: 'zgh' }],
})

// Workspace root → both project folders + a root doc; a single project → only its own files.
const fsTree = vi.fn(async (cwd: string) => {
  if (cwd.endsWith('/go-blog')) return [{ type: 'file', name: 'main.go', path: 'main.go' }]
  if (cwd.endsWith('/zgh')) return [{ type: 'file', name: 'zgh.go', path: 'zgh.go' }]
  return [
    { type: 'dir', name: 'go-blog', path: 'go-blog', children: [{ type: 'file', name: 'main.go', path: 'go-blog/main.go' }] },
    { type: 'dir', name: 'zgh', path: 'zgh', children: [{ type: 'file', name: 'zgh.go', path: 'zgh/zgh.go' }] },
    { type: 'file', name: 'ARCHITECTURE.md', path: 'ARCHITECTURE.md' },
  ]
})

beforeEach(() => {
  fsTree.mockClear()
  ;(window as any).forge = {
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(),
    onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree,
    gitDiff: vi.fn(async () => []), gitFile: async () => ({ text: 'x', lang: 'ts' }),
    onChangesEvent: () => () => {}, changesMulti: async () => ({ total: 0, add: 0, del: 0, byProject: [] }),
    getWorkspace: async (p: string) => wsInfo(p),
  }
})

const pickerLabel = () => document.querySelector('#pane-files .ipk-name')?.textContent
const topFolders = () => [...document.querySelectorAll('#fileTree > .tree-folder')].map(e => e.getAttribute('data-folder'))

describe('WorkspaceView 文件树 for a multi-project workspace (engine.run === null)', () => {
  it('defaults to 全部项目: both projects are top-level folders, plus root files', async () => {
    render(<WorkspaceView engine={idle} providers={providers} workspacePath="/example" />)
    fireEvent.click(screen.getByText('文件树'))
    await waitFor(() => expect(topFolders()).toEqual(['go-blog', 'zgh']))
    expect(screen.getByText('ARCHITECTURE.md')).toBeInTheDocument()
    expect(pickerLabel()).toBe('全部项目')
    expect(fsTree).toHaveBeenCalledWith('/example')
  })

  it('a single-project pick does not stick: switching workspace (and back) returns to 全部项目', async () => {
    const { rerender } = render(<WorkspaceView engine={idle} providers={providers} workspacePath="/example" />)
    fireEvent.click(screen.getByText('文件树'))
    await waitFor(() => expect(topFolders()).toEqual(['go-blog', 'zgh']))
    // pick go-blog in the picker → tree narrows to that one project
    fireEvent.click(document.querySelector('#pane-files .ipk-trigger')!)
    fireEvent.click([...document.querySelectorAll('#pane-files .ipk-pop .menu-item')].find(b => b.textContent === 'go-blog')!)
    await waitFor(() => expect(screen.getByText('main.go')).toBeInTheDocument())
    expect(pickerLabel()).toBe('go-blog')

    // switch to another workspace, then back (App reuses one WorkspaceView; only the prop changes)
    rerender(<WorkspaceView engine={idle} providers={providers} workspacePath="/other" />)
    await waitFor(() => expect(fsTree).toHaveBeenCalledWith('/other'))
    rerender(<WorkspaceView engine={idle} providers={providers} workspacePath="/example" />)
    await waitFor(() => expect(pickerLabel()).toBe('全部项目'))
    await waitFor(() => expect(topFolders()).toEqual(['go-blog', 'zgh']))
  })

  it('a live run listing only some projects does not hide the workspace\'s other projects', async () => {
    const run: RunState = {
      id: 'r', workspaceName: 'example', workspacePath: '/example',
      projects: [{ name: 'go-blog', cwd: '/example/go-blog' }],
      status: 'run', stages: [], pending: [],
    } as RunState
    const live: EngineApi = { run, pending: [], resolve: () => {}, cancel: () => {} }
    render(<WorkspaceView engine={live} providers={providers} workspacePath="/example" />)
    fireEvent.click(screen.getByText('文件树'))
    await waitFor(() => expect(topFolders()).toEqual(['go-blog', 'zgh']))
    expect(pickerLabel()).toBe('全部项目')
  })
})
