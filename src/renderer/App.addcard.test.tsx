import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App } from './App'

beforeEach(() => {
  ;(window as any).forge = {
    listWorkspaces: async () => [],
    homeStats: async () => ({}),
    openWorkspaceDir: async () => [],
    onEngineEvent: () => () => {},
    onNavigateWorkspace: () => () => {},
    onSetupEvent: () => () => {},
    listProjects: async () => [],
    listWorkflows: async () => [{ id: 'standard', name: '标准工作流', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] }],
    detectProviders: async () => [],
    addProject: async () => [],
    deleteProject: async () => [],
    addWorkflow: vi.fn(async () => []),
    deleteWorkflow: vi.fn(async () => []),
    getSettings: async () => ({}),
    setSettings: async (s: any) => s,
    onSettingsChanged: () => () => {},
    createWorkspace: vi.fn(),
    startRun: vi.fn(),
    resolve: () => {},
    chatHistory: async () => [],
    sendChat: async () => ({}),
    openFiles: async () => [],
    savePaste: vi.fn(),
    onChatEvent: () => () => {},
    onChatQueueEvent: () => () => {},
    watchChanges: async () => [],
    watchStop: async () => {},
    fsTree: async () => [],
    gitDiff: async () => [],
    gitFile: async () => ({ text: '', lang: 'text' }),
    onChangesEvent: () => () => {},
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: async () => {},
    startUpdate: async () => {},
    onUpdateEvent: () => () => {},
    getWorkspace: async () => null, runWorkspace: vi.fn(async () => {}),
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], installExamplePlugin: async () => {},
    onPluginsChanged: () => () => {},
  }
})

describe('App 新建流程 add-card flow', () => {
  it('clicking [data-crnewwf] opens the inline workflow designer without leaving the wizard', async () => {
    render(<App />)

    // Open the create wizard
    await waitFor(() => expect(screen.getByLabelText('新建工作区')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('新建工作区'))

    // Wizard is open: wait for the add-card button
    await waitFor(() => expect(document.querySelector('[data-crnewwf]')).toBeTruthy())

    // Click the 新建流程 add-card button → inline designer opens in-place (App provides onAddWorkflow)
    fireEvent.click(document.querySelector('[data-crnewwf]') as HTMLElement)

    // The inline designer appears and the wizard stays open (path input still present)
    await waitFor(() => expect(document.querySelector('[data-crwf-name]')).toBeTruthy())
    expect(document.querySelector('#crPath')).toBeTruthy()
  })
})
