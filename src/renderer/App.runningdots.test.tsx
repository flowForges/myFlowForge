import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { App } from './App'
import type { ChatQueueEvent, SessionsFile } from '@shared/types'

// Regression coverage for the concurrent-session union: batch-1 wired `ChatQueueEvent.runningSessionIds`
// (plural, string[]) through App's `runningSessByWs` state + `runningSessionIds` useMemo (App.tsx) down to
// SessionTabs' `runningIds` prop, so that MULTIPLE sessions running at once each get their tab dot lit —
// not just whichever session happened to be `runningSessionId` (singular). There was no App-level test
// proving two concurrently-running sessions both light up; a revert to the old singular-only logic would
// pass every other existing test (they only ever exercise a single running session) while silently
// collapsing the second dot. This test drives a real ChatQueueEvent with two ids through the actual
// onChatQueueEvent subscription and asserts BOTH session tabs carry the `run` class.

let navigate: (p: { path: string }) => void
// Both App and WorkspaceView independently subscribe via window.forge.onChatQueueEvent (App tracks
// runningSessionIds/busy state; WorkspaceView drives its own task-queue panel). A mock that only
// remembers the LAST subscriber would silently miss App's handler — the one this test actually
// exercises — so fire every registered callback.
const queueCbs: ((e: ChatQueueEvent) => void)[] = []
const fireQueueEvent = (e: ChatQueueEvent) => { for (const cb of queueCbs) cb(e) }

const WS_PATH = '~/code/ds'

const sessionsFile: SessionsFile = {
  sessions: [
    { id: 's1', title: '会话A', mode: 'chat', createdAt: 0 },
    { id: 's2', title: '会话B', mode: 'chat', createdAt: 1 },
  ],
  activeSessionId: 's1',
}

beforeEach(() => {
  navigate = () => {}
  queueCbs.length = 0
  ;(window as any).forge = {
    listWorkspaces: async () => [{ name: 'design-system', path: WS_PATH, projectCount: 1, workflowId: 'standard', status: 'idle' }],
    openWorkspaceDir: async () => [],
    homeStats: async () => ({}),
    onEngineEvent: () => () => {},
    onNavigateWorkspace: (cb: (p: { path: string }) => void) => { navigate = cb; return () => {} },
    onSetupEvent: () => () => {},
    listProjects: async () => [], listWorkflows: async () => [],
    detectProviders: async () => [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }],
    addProject: async () => [], deleteProject: async () => [],
    createWorkspace: vi.fn(), startRun: vi.fn(async () => ({})), resolve: () => {},
    getSettings: async () => ({}), setSettings: async (s: any) => s, onSettingsChanged: () => () => {},
    getWorkspace: async () => null, runWorkspace: vi.fn(async () => {}),
    lastRun: vi.fn(async () => null),
    sessionList: vi.fn(async () => sessionsFile),
    chatHistory: async () => [], sendChat: async () => ({}), onChatEvent: () => () => {},
    onChatQueueEvent: (cb: (e: ChatQueueEvent) => void) => {
      queueCbs.push(cb)
      return () => { const i = queueCbs.indexOf(cb); if (i >= 0) queueCbs.splice(i, 1) }
    },
    openFiles: async () => [], savePaste: vi.fn(),
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
    gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {},
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: async () => {}, startUpdate: async () => {}, onUpdateEvent: () => () => {},
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], installExamplePlugin: async () => {},
    onPluginsChanged: () => () => {},
  }
})

describe('App concurrent running-session dots', () => {
  it('lights BOTH session tab dots when a ChatQueueEvent carries two runningSessionIds', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(screen.queryAllByText('design-system').length).toBeGreaterThan(0))
    act(() => navigate({ path: WS_PATH }))
    await waitFor(() => expect(container.querySelectorAll('#sessTabs .sess-tab')).toHaveLength(2))
    await waitFor(() => expect(queueCbs.length).toBeGreaterThan(0))

    act(() => fireQueueEvent({
      workspacePath: WS_PATH,
      busy: true,
      queue: [],
      running: { id: 't1', text: 'do a', sessionId: 's1' },
      runningTurns: [
        { id: 't1', text: 'do a', sessionId: 's1' },
        { id: 't2', text: 'do b', sessionId: 's2' },
      ],
      runningSessionId: 's1',
      runningSessionIds: ['s1', 's2'],
    }))

    await waitFor(() => {
      const dots = container.querySelectorAll('#sessTabs .sd')
      expect(dots).toHaveLength(2)
      expect(dots[0].className).toContain('run')
      expect(dots[1].className).toContain('run')
    })
  })
})
