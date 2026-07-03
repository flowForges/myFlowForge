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
    listProjects: async () => [], listWorkflows: async () => [], detectProviders: async () => [],
    addProject: async () => [], deleteProject: async () => [], addWorkflow: async () => [], deleteWorkflow: async () => [],
    getSettings: async () => ({}), setSettings: async (s: any) => s, onSettingsChanged: () => () => {},
    scanContext: vi.fn(async () => ({ skills: [{ name: 'forge-workflow', path: '.claude/skills/forge-workflow/SKILL.md' }], rules: [{ name: 'AGENTS.md', path: 'AGENTS.md' }], mcps: [{ name: 'forge', path: 'mcp://forge' }] })),
    createWorkspace: vi.fn(), startRun: vi.fn(), resolve: () => {},
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(), onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [], gitDiff: async () => ({ text: '', lang: 'text' }), onChangesEvent: () => () => {},
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: async () => {},
    startUpdate: async () => {},
    onUpdateEvent: () => () => {},
    getWorkspace: async () => null, runWorkspace: vi.fn(async () => {}),
    listSkills: async () => [{ name: 'code-review', description: '审查 diff', source: 'Claude', path: '~/.claude/skills/code-review/SKILL.md' }],
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], installExamplePlugin: async () => {},
    onPluginsChanged: () => () => {},
  }
})

describe('App skill + pet settings', () => {
  it('renders SkillPane and PetPane in their tabs', async () => {
    render(<App />)
    fireEvent.click(screen.getByLabelText('设置'))
    fireEvent.click(document.querySelector('[data-set="skills"]') as HTMLElement)
    expect(await screen.findByText('code-review')).toBeInTheDocument()
    fireEvent.click(document.querySelector('[data-set="pet"]') as HTMLElement)
    expect(await screen.findByText('桌面宠物')).toBeInTheDocument()
  })

  it('renders LoadPane and scans workspace load items', async () => {
    render(<App />)
    fireEvent.click(screen.getByLabelText('设置'))
    fireEvent.click(document.querySelector('[data-set="loads"]') as HTMLElement)
    expect(await screen.findByText('加载项扫描')).toBeInTheDocument()
    expect(await screen.findByText('forge-workflow')).toBeInTheDocument()
    expect(await screen.findByText('AGENTS.md')).toBeInTheDocument()
    expect(await screen.findByText('forge')).toBeInTheDocument()
  })
})
