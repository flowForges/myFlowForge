import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App } from './App'

beforeEach(() => {
  ;(window as any).forge = {
    listWorkspaces: async () => [], openWorkspaceDir: async () => [],
    homeStats: async () => ({}),
    onEngineEvent: () => () => {},
    onNavigateWorkspace: () => () => {},
    onSetupEvent: () => () => {},
    listProjects: async () => [],
    listWorkflows: async () => [{ id: 'standard', name: '标准工作流', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] }],
    detectProviders: async () => [],
    addProject: async () => [], deleteProject: async () => [],
    addWorkflow: vi.fn(async () => []), deleteWorkflow: vi.fn(async () => []),
    getSettings: async () => ({}), setSettings: async (s: any) => s, onSettingsChanged: () => () => {},
    createWorkspace: vi.fn(), startRun: vi.fn(), resolve: () => {},
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

describe('App workflow settings', () => {
  it('renders the WorkflowPane in the 工作流 settings tab', async () => {
    render(<App />)
    // Open settings via the titlebar gear (aria-label="设置").
    fireEvent.click(screen.getByLabelText('设置'))
    // The 工作流 nav button lives in the settings nav (data-set="workflow").
    const navBtn = await waitFor(() => document.querySelector('[data-set="workflow"]') as HTMLElement)
    expect(navBtn).toBeTruthy()
    fireEvent.click(navBtn)
    expect(await screen.findByText('标准工作流')).toBeInTheDocument()
  })
})
