import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { App } from './App'

beforeEach(() => {
  ;(window as any).forge = {
    onEngineEvent: () => () => {},
    onNavigateWorkspace: () => () => {},
    onSetupEvent: () => () => {},
    listProjects: async () => [], listWorkflows: async () => [], detectProviders: async () => [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }],
    addProject: async () => [], deleteProject: async () => [], addWorkflow: async () => [], deleteWorkflow: async () => [],
    getSettings: async () => ({}), setSettings: async (s: any) => s, onSettingsChanged: () => () => {},
    listWorkspaces: async () => [{ name: 'design-system', path: '~/code/ds', projectCount: 2, workflowId: 'standard', status: 'idle' }],
    homeStats: async () => ({}),
    openWorkspaceDir: async () => [],
    createWorkspace: vi.fn(), startRun: vi.fn(), resolve: () => {},
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(), onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [], gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'text' }), onChangesEvent: () => () => {},
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: async () => {},
    startUpdate: async () => {},
    onUpdateEvent: () => () => {},
    getWorkspace: async () => null, runWorkspace: vi.fn(async () => {}),
    lastRun: async () => null,
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], installExamplePlugin: async () => {},
    onPluginsChanged: () => () => {},
  }
})

describe('App home view', () => {
  it('opens the home view by default on launch (new users see HomeView, not an empty workspace)', async () => {
    const { container } = render(<App />)
    // No navigation — the initial view must already be the home view.
    await waitFor(() => expect(container.querySelector('#view-home')).not.toBeNull())
    expect(container.querySelector('.window.home-mode')).not.toBeNull()
  })

  it('shows HomeView when the home tab is active', async () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByText('首页'))
    // scope to the HomeView section (#view-home) since the sidebar also lists 'design-system'
    const home = await waitFor(() => {
      const el = container.querySelector('#view-home')
      if (!el) throw new Error('home view not rendered')
      return el as HTMLElement
    })
    // findByText polls until the async listWorkspaces result populates the home view — the #view-home
    // node mounts before the workspace list resolves, so a sync getByText here races under load.
    expect(await within(home).findByText('design-system')).toBeInTheDocument()
  })

  it('launchpad mode on home hides the sidebar toggle; entering a workspace restores it', async () => {
    const { container } = render(<App />)
    // home view by default → home-mode on, sidebar toggle hidden
    await waitFor(() => expect(container.querySelector('#view-home')).not.toBeNull())
    expect(container.querySelector('.window.home-mode')).not.toBeNull()
    expect(screen.queryByTitle('折叠侧栏')).toBeNull()
    // enter a workspace via the sidebar → home-mode off, toggle back
    const sidebarItem = await waitFor(() => {
      const el = container.querySelector('.ws-item')
      if (!el) throw new Error('sidebar workspace item not rendered')
      return el as HTMLElement
    })
    fireEvent.click(sidebarItem)
    expect(container.querySelector('.window.home-mode')).toBeNull()
    expect(screen.getByTitle('折叠侧栏')).toBeInTheDocument()
  })

  it('clicking a sidebar workspace from the home view switches back to the workspace view', async () => {
    const { container } = render(<App />)
    // Go to the home view first.
    fireEvent.click(screen.getByText('首页'))
    await waitFor(() => expect(container.querySelector('#view-home')).not.toBeNull())
    // Click the workspace entry in the SIDEBAR (.ws-item), not the home card.
    const sidebarItem = await waitFor(() => {
      const el = container.querySelector('.ws-item')
      if (!el) throw new Error('sidebar workspace item not rendered')
      return el as HTMLElement
    })
    fireEvent.click(sidebarItem)
    // Selecting a workspace must leave the home view (regression: onSelect only set activeId).
    expect(container.querySelector('#view-home')).toBeNull()
  })

  it('标题栏「工作区」无选中时恢复 settings.lastActiveWorkspace(上次会话随 per-ws activeSessionId 自动回来)', async () => {
    ;(window as any).forge.getSettings = async () => ({ lastActiveWorkspace: '~/code/ds' })
    const { container } = render(<App />)
    await waitFor(() => expect(container.querySelector('#view-home')).not.toBeNull())
    fireEvent.click(container.querySelector('button[data-go="ws"]') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.window.home-mode')).toBeNull())
    // 恢复了 design-system:侧栏该项高亮(.on),而不是无选中的死输入框
    await waitFor(() => expect(container.querySelector('.ws-item.on')).not.toBeNull())
    expect((container.querySelector('.ws-item.on') as HTMLElement).textContent).toContain('design-system')
  })

  it('标题栏「工作区」无 lastActiveWorkspace 时回退到最近活跃的工作区', async () => {
    ;(window as any).forge.listWorkspaces = async () => [
      { name: 'old-ws', path: '~/code/old', projectCount: 1, workflowId: 'standard', status: 'idle' },
      { name: 'fresh-ws', path: '~/code/fresh', projectCount: 1, workflowId: 'standard', status: 'idle' },
    ]
    ;(window as any).forge.homeStats = async () => ({ '~/code/fresh': { lastMessageAt: 2000 }, '~/code/old': { lastMessageAt: 1000 } })
    const { container } = render(<App />)
    await waitFor(() => expect(container.querySelector('#view-home')).not.toBeNull())
    await waitFor(() => expect(container.querySelectorAll('.ws-item').length).toBe(2))
    fireEvent.click(container.querySelector('button[data-go="ws"]') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.ws-item.on')).not.toBeNull())
    expect((container.querySelector('.ws-item.on') as HTMLElement).textContent).toContain('fresh-ws')
  })

  it('标题栏「工作区」一个工作区都没有时留在首页(不出现死的空 Composer)', async () => {
    ;(window as any).forge.listWorkspaces = async () => []
    const { container } = render(<App />)
    await waitFor(() => expect(container.querySelector('#view-home')).not.toBeNull())
    fireEvent.click(container.querySelector('button[data-go="ws"]') as HTMLElement)
    // 仍是首页
    expect(container.querySelector('.window.home-mode')).not.toBeNull()
    expect(container.querySelector('#view-home')).not.toBeNull()
  })
})
