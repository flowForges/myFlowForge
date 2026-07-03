import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { App } from './App'

beforeEach(() => {
  ;(window as any).forge = {
    listWorkspaces: async () => [], openWorkspaceDir: async () => [],
    homeStats: async () => ({}),
    onEngineEvent: () => () => {},
    onNavigateWorkspace: () => () => {},
    onSetupEvent: () => () => {},
    listProjects: async () => [], listWorkflows: async () => [], detectProviders: async () => [],
    addProject: async () => [], deleteProject: async () => [],
    getSettings: async () => ({ appearance: { theme: 'light', vibrancy: false, density: 'compact', fontSize: 'large' }, termProxy: '' }),
    setSettings: async (s: any) => s, onSettingsChanged: () => () => {},
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

describe('App settings + theme', () => {
  it('applies the loaded theme to the document root on mount', async () => {
    render(<App />)
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'))
    expect(document.documentElement.getAttribute('data-density')).toBe('compact')
    expect(document.documentElement.getAttribute('data-font')).toBe('large')
  })
})
