import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import type { EngineEvent, RunState } from '@shared/types'

let listeners: Array<(e: EngineEvent) => void>

beforeEach(() => {
  listeners = []
  ;(window as any).forge = {
    listWorkspaces: async () => [], openWorkspaceDir: async () => [],
    homeStats: async () => ({}),
    onEngineEvent: (cb: (e: EngineEvent) => void) => { listeners.push(cb); return () => {} },
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

function emit(e: EngineEvent) {
  for (const listener of listeners) listener(e)
}

function notificationTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.ni-t')).map(el => el.textContent ?? '')
}

function runWithAgent(state: RunState['stages'][number]['agents'][number]['state']): RunState {
  return {
    id: 'r1',
    workspaceName: 'ws',
    workspacePath: '/tmp/ws',
    status: 'run',
    projects: [],
    pending: [],
    stages: [{
      key: 'develop',
      name: '开发',
      state: 'run',
      agents: [{ id: 'a1', name: '<img src=x onerror=alert(1)>dev', role: '开发', provider: 'claude', model: 'opus-4.8', state, logs: [] }],
    }],
  }
}

describe('App lifecycle notifications', () => {
  it('routes stalled lifecycle events into sanitized unread notifications', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0))

    act(() => emit({ type: 'agent:stalled', agentId: 'a1', agentName: '<img src=x onerror=alert(1)>dev', wsName: 'ws', silentMs: 90_000 }))
    fireEvent.click(screen.getByTitle('通知'))

    await waitFor(() => expect(notificationTexts(container).some(text => text.includes('dev 疑似卡住'))).toBe(true))
    const notifHtml = container.querySelector('.notif-list')?.innerHTML ?? ''
    expect(notifHtml).not.toContain('<img')
    expect(notifHtml).not.toContain('onerror')
    // The center starts empty (no mock seed), so a single stalled event = exactly 1 unread.
    expect(screen.getByText('1 条未读')).toBeInTheDocument()
  })

  it('starts with an empty notification center — no persistent fake badge', async () => {
    render(<App />)
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0))
    const bell = screen.getByTitle('通知')
    // No real notifications yet → bell carries no unread badge.
    expect(bell.className).not.toContain('has')
    fireEvent.click(bell)
    expect(screen.getByText('暂无通知')).toBeInTheDocument()
    expect(screen.getByText('已全部读完')).toBeInTheDocument()
  })

  it('routes awaiting, done, and failed lifecycle transitions into notifications', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0))

    act(() => {
      emit({ type: 'pending:add', action: { id: 'p1', kind: 'confirm', agentId: 'a1', agentName: 'dev', wsName: 'ws', title: '确认' } })
      emit({ type: 'run:update', run: runWithAgent('ok') })
      emit({ type: 'run:update', run: runWithAgent('err') })
    })
    fireEvent.click(screen.getByTitle('通知'))

    await waitFor(() => expect(notificationTexts(container).some(text => text.includes('dev 需要你确认/输入'))).toBe(true))
    expect(notificationTexts(container).some(text => text.includes('dev 已完成'))).toBe(true)
    expect(notificationTexts(container).some(text => text.includes('dev 失败/被终止'))).toBe(true)
  })
})
