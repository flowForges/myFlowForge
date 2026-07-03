import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, SessionsFile, ChatMessage } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]
const engine: EngineApi = { run: undefined, pending: [], resolve: vi.fn(), cancel: vi.fn() } as any
const file = (active: string): SessionsFile => ({
  sessions: [
    { id: 's1', title: 'OKLch 迁移', mode: 'workflow', createdAt: 0 },
    { id: 's2', title: '新会话', mode: 'chat', createdAt: 1 },
  ],
  activeSessionId: active,
})
const histories: Record<string, ChatMessage[]> = {
  s1: [{ id: 'm1', who: 'user', text: '历史 A', ts: '0' }],
  s2: [{ id: 'm2', who: 'user', text: '历史 B', ts: '0' }],
}

beforeEach(() => {
  ;(window as any).forge = {
    sessionList: vi.fn(async () => file('s1')),
    sessionSwitch: vi.fn(async () => file('s2')),
    sessionNew: vi.fn(async () => file('s2')),
    sessionClose: vi.fn(async () => file('s1')),
    sessionRename: vi.fn(async () => file('s1')),
    chatHistory: vi.fn(async (_ws: string, sid: string) => histories[sid] ?? []),
    sendChat: vi.fn(async () => ({})),
    onChatEvent: () => () => {},
    onChatQueueEvent: () => () => {},
    chatCancelQueued: vi.fn(async () => ({})),
    chatClearQueue: vi.fn(async () => ({})),
    lastRun: vi.fn(async () => null),
    getWorkspace: vi.fn(async () => ({ projects: [{ branch: 'main' }], stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }] })),
    changesMulti: vi.fn(async () => ({ total: 0, add: 0, del: 0, byProject: [] })),
    watchChanges: vi.fn(async () => []),
    watchStop: vi.fn(async () => undefined),
    fsTree: vi.fn(async () => []),
    onChangesEvent: vi.fn(() => () => {}),
    savePaste: vi.fn(async () => ({})),
  }
})

describe('WorkspaceView sessions', () => {
  it('renders tabs and reloads chat history when switching or creating sessions', async () => {
    render(<WorkspaceView engine={engine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('OKLch 迁移')).toBeTruthy())
    expect(screen.getByText('新会话')).toBeTruthy()
    await waitFor(() => expect((window as any).forge.chatHistory).toHaveBeenCalledWith('/ws', 's1'))

    fireEvent.click(screen.getByText('新会话'))
    await waitFor(() => expect((window as any).forge.sessionSwitch).toHaveBeenCalledWith({ workspacePath: '/ws', sessionId: 's2' }))
    await waitFor(() => expect((window as any).forge.chatHistory).toHaveBeenCalledWith('/ws', 's2'))

    fireEvent.click(screen.getByTitle('新建会话'))
    await waitFor(() => expect((window as any).forge.sessionNew).toHaveBeenCalledWith('/ws'))
  })
})
