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
  it('clicking [data-crnewwf] closes the wizard and opens settings at workflow pane', async () => {
    render(<App />)

    // Open the create wizard
    await waitFor(() => expect(screen.getByLabelText('新建工作区')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('新建工作区'))

    // Wizard is open: wait for the add-card button
    await waitFor(() => expect(document.querySelector('[data-crnewwf]')).toBeTruthy())

    // Click the 新建流程 add-card button
    const addBtn = document.querySelector('[data-crnewwf]') as HTMLElement
    fireEvent.click(addBtn)

    // Wizard should be closed (no path input visible)
    await waitFor(() => expect(document.querySelector('#createOverlay')).toBeNull())

    // Settings modal should be open showing workflow pane
    await waitFor(() => {
      const wfNav = document.querySelector('[data-set="workflow"]') as HTMLElement
      expect(wfNav).toBeTruthy()
      expect(wfNav.className).toContain('on')
    })
  })
})
