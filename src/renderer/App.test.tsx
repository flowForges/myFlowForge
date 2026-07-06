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
    listProjects: async () => [{ id: 'proj1', name: 'proj1', repoUrl: 'u', defaultBranch: 'main' }],
    listWorkflows: async () => [{ id: 'standard', name: '标准工作流', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] }],
    detectProviders: async () => [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }],
    addProject: async () => [], deleteProject: async () => [],
    createWorkspace: vi.fn(async (opts) => ({ workspace: { name: opts.name, path: opts.path, projects: [], workflowId: 'standard', status: 'idle' }, startRunOpts: { runId: 'r', workspaceName: opts.name, workspacePath: opts.path, stages: [], developProjects: [] } })),
    startRun: vi.fn(async () => ({})),
    resolve: () => {}, getSettings: async () => ({}), setSettings: async () => ({}), onSettingsChanged: () => () => {},
    getWorkspace: async () => null, runWorkspace: vi.fn(async () => {}),
    onChatEvent: () => () => {}, onChatQueueEvent: () => () => {}, chatHistory: async () => [], sendChat: async () => ({}),
    openFiles: async () => [], savePaste: vi.fn(),
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
    gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {},
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: async () => {},
    startUpdate: async () => {},
    onUpdateEvent: () => () => {},
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], installExamplePlugin: async () => {},
    onPluginsChanged: () => () => {},
  }
})

describe('App create flow', () => {
  it('opens the wizard from the sidebar + button', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByLabelText('新建工作区')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('新建工作区'))
    expect(await screen.findByPlaceholderText('~/code/')).toBeInTheDocument()
  })
})
