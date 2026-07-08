import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EventBus } from '../orchestrator/eventBus'
import { CH } from './channels'

// Focused routing test for CH.workspaceCreate: always routes through runWorkspaceSetup (observable
// progress path), regardless of step plugins. createWorkspace is mocked only to prove it's never called.

const { createWorkspaceMock, runWorkspaceSetupMock, subscribers } = vi.hoisted(() => ({
  createWorkspaceMock: vi.fn(async () => ({ workspace: { name: 'fast' }, startRunOpts: {} })),
  runWorkspaceSetupMock: vi.fn(async () => ({ workspace: { name: 'setup' }, startRunOpts: {} })),
  subscribers: [] as Array<(e: any) => void>,
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {} }))
vi.mock('../orchestrator/orchestrator', () => ({
  Orchestrator: class { startRun() {} resolve() {} getRun() { return null } }
}))
vi.mock('../orchestrator/eventBus', () => ({
  EventBus: class {
    subscribe(fn: (e: any) => void) { subscribers.push(fn); return () => {} }
    emit(e: any) { subscribers.forEach(fn => fn(e)) }
  }
}))
vi.mock('../orchestrator/runStore', () => ({ readLastRun: vi.fn(), RunStore: class { get runDir() { return '/tmp' } } }))
vi.mock('../mcp/forgeBridge', () => ({ startBridge: vi.fn(() => Promise.resolve(null)) }))
vi.mock('../chat/proposeRun', () => {
  const fn: any = vi.fn(); fn.has = vi.fn(() => false); fn.resolve = vi.fn()
  return { makeProposeRun: vi.fn(() => fn) }
})
vi.mock('../narrator/narratorService', () => ({ NarratorService: class { onEngineEvent() {} } }))
vi.mock('../workspace/workspaceList', () => ({ listWorkspaces: vi.fn(() => []) }))
vi.mock('../workspace/workspaceRun', () => ({ workspaceToStartRunOpts: vi.fn() }))
vi.mock('../chat/chatService', () => ({ sendTurn: vi.fn(), history: vi.fn(() => []) }))
vi.mock('../skills/installSkill', () => ({ ensureWorkspaceSkill: vi.fn() }))
vi.mock('../chat/chatStore', () => ({ appendMessage: vi.fn(), readMessages: vi.fn(() => []) }))
vi.mock('../chat/sessionStore', () => ({
  readSessions: vi.fn(() => ({ sessions: [], activeSessionId: 's1' })),
  newSession: vi.fn(), switchSession: vi.fn(), closeSession: vi.fn(), renameSession: vi.fn(),
}))
vi.mock('../config/store', () => ({
  readSettings: () => ({ termProxy: 'px', pinnedWorkspaces: [] }),
  writeSettings: vi.fn(),
  readProjects: () => ({ projects: [{ id: 'proj', name: 'proj', repoUrl: '', defaultBranch: 'main' }] }),
  writeProjects: vi.fn(), readWorkflows: () => ({ workflows: [] }), writeWorkflows: vi.fn(),
  registerWorkspace: vi.fn(), readWorkspace: vi.fn(), writeWorkspace: vi.fn(),
  readAgentsConfig: vi.fn(() => ({ providers: [], custom: [] })), writeAgentsConfig: vi.fn(),
  readWorkspaceRegistry: () => [],   // consumed by the startup session-mode heal loop in registerIpc
  readHookLibrary: () => ({ hooks: [] }), writeHookLibrary: vi.fn(),
}))
vi.mock('../workspace/workspaceService', () => ({
  createWorkspace: createWorkspaceMock,
  editWorkspace: vi.fn(),
}))
vi.mock('../workspace/workspaceSetup', () => ({
  runWorkspaceSetup: runWorkspaceSetupMock,
}))

const BASE_OPTS = {
  name: 'w', path: '/ws/a', workflowId: 'standard',
  stages: [{ key: 'develop', provider: 'claude', model: 'm' }],
  projects: [{ repoId: 'proj', branch: 'b' }],
}

async function invoke(channel: string, broadcast: (ch: string, p: unknown) => void, providers: any, ...args: unknown[]) {
  const { registerIpc } = await import('./handlers')
  const { ipcMain } = await import('electron') as any
  ;(ipcMain.handle as any).mockClear()
  registerIpc(broadcast, providers)
  const call = (ipcMain.handle as any).mock.calls.find((c: any[]) => c[0] === channel)
  return call[1]({}, ...args)
}

beforeEach(() => { createWorkspaceMock.mockClear(); runWorkspaceSetupMock.mockClear(); subscribers.length = 0 })

describe('CH.workspaceCreate routing', () => {
  it('no step plugins → still routes through runWorkspaceSetup (observable path)', async () => {
    const res = await invoke(CH.workspaceCreate, () => {}, {}, BASE_OPTS)
    expect(runWorkspaceSetupMock).toHaveBeenCalledTimes(1)
    expect(createWorkspaceMock).not.toHaveBeenCalled()
    expect(res.workspace.name).toBe('setup')
  })

  it('__wf-only step plugins also route through runWorkspaceSetup', async () => {
    await invoke(CH.workspaceCreate, () => {}, {}, { ...BASE_OPTS, stepPlugins: [{ id: 'w', name: 'W', prompt: '', after: '__wf', skills: [], tools: [] }] })
    expect(runWorkspaceSetupMock).toHaveBeenCalledTimes(1)
    expect(createWorkspaceMock).not.toHaveBeenCalled()
  })

  it('a __basic step plugin → runWorkspaceSetup, wired to broadcast workspace:setup events', async () => {
    const sent: [string, unknown][] = []
    const providers = { claude: { id: 'claude' } }
    const res = await invoke(CH.workspaceCreate, (ch, p) => sent.push([ch, p]), providers,
      { ...BASE_OPTS, stepPlugins: [{ id: 'b', name: 'B', prompt: '', after: '__basic', skills: [], tools: ['read'] }] })
    expect(runWorkspaceSetupMock).toHaveBeenCalledTimes(1)
    expect(createWorkspaceMock).not.toHaveBeenCalled()
    const arg = (runWorkspaceSetupMock.mock.calls[0] as any[])[0] as any
    expect(arg.proxy).toBe('px')
    expect(arg.providers).toBe(providers)
    expect(arg.knownProjects[0].id).toBe('proj')
    // emit forwards a SetupEvent onto the workspace:setup broadcast channel
    arg.emit({ type: 'setup:done', workspacePath: '/ws/a' })
    expect(sent).toContainEqual([CH.workspaceSetup, { type: 'setup:done', workspacePath: '/ws/a' }])
    expect(res.workspace.name).toBe('setup')
  })

  it('a __proj step plugin → runWorkspaceSetup', async () => {
    await invoke(CH.workspaceCreate, () => {}, {},
      { ...BASE_OPTS, stepPlugins: [{ id: 'p', name: 'P', prompt: '', after: '__proj', skills: [], tools: [] }] })
    expect(runWorkspaceSetupMock).toHaveBeenCalledTimes(1)
    expect(createWorkspaceMock).not.toHaveBeenCalled()
  })
})
