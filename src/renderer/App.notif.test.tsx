import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'

let setupListeners: Array<(e: any) => void>

beforeEach(() => {
  setupListeners = []
  ;(window as any).forge = {
    listWorkspaces: async () => [], openWorkspaceDir: async () => [],
    homeStats: async () => ({}),
    onNavigateWorkspace: () => () => {},
    onSetupEvent: (cb: (e: any) => void) => { setupListeners.push(cb); return () => {} },
    cancelSetup: async () => {},
    listProjects: async () => [{ id: 'proj1', name: 'proj1', repoUrl: 'u', defaultBranch: 'main' }],
    listWorkflows: async () => [{ id: 'standard', name: '标准工作流', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] }],
    detectProviders: async () => [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }],
    addProject: async () => [], deleteProject: async () => [],
    createWorkspace: vi.fn(async (opts) => ({ workspace: { name: opts.name, path: opts.path, projects: [], workflowId: 'standard', status: 'idle' }, workspacePath: opts.path, developProjects: [] })),
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

function emitSetup(e: any) {
  for (const listener of setupListeners) listener(e)
}

function notificationTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.ni-t')).map(el => el.textContent ?? '')
}

// NOTE: the legacy orchestrator engine-bus lifecycle notification tests (stalled / awaiting+failed /
// aggregate run-done) were removed with the orchestrator — App no longer subscribes to any engine bus,
// so those notifications no longer exist. Setup-completion + empty-center behavior remains and is
// covered below.

describe('App lifecycle notifications', () => {
  it('backgrounded setup fires a completion notification the user can click into', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(setupListeners.length).toBeGreaterThan(0))

    // Setup starts → overlay shows → user clicks 后台运行 to keep working.
    act(() => emitSetup({ type: 'setup:start', workspacePath: '/tmp/ws-bg', hooks: { basic: 1, proj: 0 } }))
    fireEvent.click(screen.getByLabelText('后台运行'))
    // A pill signals it's still running in the background.
    expect(screen.getByText(/正在后台配置工作区/)).toBeInTheDocument()

    // Setup finishes while backgrounded → a completion notification appears.
    act(() => emitSetup({ type: 'setup:done', workspacePath: '/tmp/ws-bg' }))
    await waitFor(() => expect(notificationTexts(container).some(t => t.includes('工作区创建完成'))).toBe(true))
    // ...and the pill is gone.
    expect(screen.queryByText(/正在后台配置工作区/)).not.toBeInTheDocument()
  })

  it('starts with an empty notification center — no persistent fake badge', async () => {
    render(<App />)
    const bell = await screen.findByTitle('通知')
    // No real notifications yet → bell carries no unread badge.
    expect(bell.className).not.toContain('has')
    fireEvent.click(bell)
    expect(screen.getByText('暂无通知')).toBeInTheDocument()
    expect(screen.getByText('已全部读完')).toBeInTheDocument()
  })
})
