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
    scanContext: vi.fn(async () => ({ skills: [], rules: [], mcps: [] })),
    scanGlobalContext: vi.fn(async () => ({ skills: [], rules: [], mcps: [] })),
    // 加载项 2026-09-05 换成了 addons:scan(带 provider / 可删),不再是 scanGlobalContext。
    addonsScan: vi.fn(async () => ({ home: '/home/u', addons: [
      { id: 's1', kind: 'skill', provider: 'claude', name: 'forge-workflow', path: '/home/u/.claude/skills/forge-workflow', installed: true, removable: true, removeVia: 'trash' },
      { id: 'r1', kind: 'rule', provider: 'codex', name: 'AGENTS.md', path: '/home/u/.codex/AGENTS.md', installed: true, removable: true, removeVia: 'trash' },
      { id: 'm1', kind: 'mcp', provider: 'claude', name: 'forge', path: '/home/u/.claude.json', installed: true, removable: true, removeVia: 'cli' },
    ] })),
    addonsRemove: vi.fn(async () => ({ ok: true, trashed: true, via: 'file' })),
    createWorkspace: vi.fn(), startRun: vi.fn(), resolve: () => {},
    chatHistory: async () => [], sendChat: async () => ({}), openFiles: async () => [], savePaste: vi.fn(), onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [], gitDiff: async () => ({ text: '', lang: 'text' }), onChangesEvent: () => () => {},
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: async () => {},
    startUpdate: async () => {},
    onUpdateEvent: () => () => {},
    getWorkspace: async () => null, runWorkspace: vi.fn(async () => {}),
    mcpOverview: async () => [],
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], installExamplePlugin: async () => {},
    onPluginsChanged: () => () => {},
  }
})

describe('App mcp + pet settings', () => {
  // ★2026-09-05:设置里的「Skill」那一格换成了「MCP」(Skill 和「加载项」重复,而 MCP 需要一个能点授权的地方)。
  it('renders McpPane and PetPane in their tabs', async () => {
    render(<App />)
    fireEvent.click(screen.getByLabelText('设置'))
    fireEvent.click(document.querySelector('[data-set="mcp"]') as HTMLElement)
    expect(await screen.findByText('MCP 服务器')).toBeInTheDocument()
    fireEvent.click(document.querySelector('[data-set="pet"]') as HTMLElement)
    expect(await screen.findByText('桌面宠物')).toBeInTheDocument()
  })

  it('renders LoadPane and scans system-level load items', async () => {
    render(<App />)
    fireEvent.click(screen.getByLabelText('设置'))
    fireEvent.click(document.querySelector('[data-set="loads"]') as HTMLElement)
    expect(await screen.findByText('系统级加载项')).toBeInTheDocument()
    expect(await screen.findByText('forge-workflow')).toBeInTheDocument()
    expect(await screen.findByText('AGENTS.md')).toBeInTheDocument()
    expect(await screen.findByText('forge')).toBeInTheDocument()
  })
})
