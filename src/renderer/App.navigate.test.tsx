import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { App } from './App'

let navigate: (p: { path: string }) => void

beforeEach(() => {
  navigate = () => {}
  ;(window as any).forge = {
    onEngineEvent: () => () => {},
    onNavigateWorkspace: (cb: (p: { path: string }) => void) => { navigate = cb; return () => {} },
    onSetupEvent: () => () => {},
    listProjects: async () => [], listWorkflows: async () => [],
    detectProviders: async () => [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }],
    addProject: async () => [], deleteProject: async () => [], addWorkflow: async () => [], deleteWorkflow: async () => [],
    getSettings: async () => ({}), setSettings: async (s: any) => s, onSettingsChanged: () => () => {},
    listWorkspaces: async () => [{ name: 'design-system', path: '~/code/ds', projectCount: 2, workflowId: 'standard', status: 'idle' }],
    homeStats: async () => ({}),
    openWorkspaceDir: async () => [],
    createWorkspace: vi.fn(), startRun: vi.fn(), resolve: () => {},
    lastRun: vi.fn(async () => null),
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(), onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [], gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'text' }), onChangesEvent: () => () => {},
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: async () => {},
    startUpdate: async () => {},
    onUpdateEvent: () => () => {},
    getWorkspace: async () => null, runWorkspace: vi.fn(async () => {}),
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], installExamplePlugin: async () => {},
    onPluginsChanged: () => () => {},
  }
})

describe('App navigate-from-pet', () => {
  it('switches from home view to the workspace view when navigateWorkspace fires', async () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByText('首页'))
    await waitFor(() => expect(container.querySelector('#view-home')).not.toBeNull())
    act(() => navigate({ path: '~/code/ds' }))
    await waitFor(() => expect(container.querySelector('#view-home')).toBeNull())
  })

  it('titlebar crumb follows the viewed workspace, not the live run', async () => {
    render(<App />)
    // Wait for workspaces to load (listWorkspaces returns design-system at ~/code/ds).
    // The app now boots on the home view, so the name shows in both the sidebar and the home card.
    await waitFor(() => expect(screen.queryAllByText('design-system').length).toBeGreaterThan(0))
    // Navigate to the workspace — crumb should reflect the workspace name
    act(() => navigate({ path: '~/code/ds' }))
    await waitFor(() => {
      const crumbEl = document.querySelector('.crumb b')
      expect(crumbEl?.textContent).toBe('design-system')
    })
  })

  it('clears the titlebar crumb on the home view (shows just Forge, not a stale workspace)', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(screen.queryAllByText('design-system').length).toBeGreaterThan(0))
    // First land on a workspace so the crumb is populated.
    act(() => navigate({ path: '~/code/ds' }))
    await waitFor(() => expect(document.querySelector('.crumb b')?.textContent).toBe('design-system'))
    // Switch to the home view — the breadcrumb must drop the workspace name.
    fireEvent.click(screen.getByText('首页'))
    await waitFor(() => expect(container.querySelector('#view-home')).not.toBeNull())
    expect(document.querySelector('.crumb b')).toBeNull()
  })
})
