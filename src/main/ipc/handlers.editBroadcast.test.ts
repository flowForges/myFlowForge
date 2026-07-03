import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EventBus } from '../orchestrator/eventBus'
import { CH } from './channels'

// Focused test: CH.workspaceEdit handler must broadcast workspacesChanged on success.

const { subscribers } = vi.hoisted(() => ({
  subscribers: [] as Array<(e: any) => void>,
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const editWorkspaceMock = vi.fn(async (_a: any) => ({ workspace: { name: 'edited' } } as any))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {} }))
vi.mock('../orchestrator/orchestrator', () => ({
  Orchestrator: class {
    startRun() {}
    resolve() {}
    getRun() { return null }
  }
}))
vi.mock('../orchestrator/eventBus', () => ({
  EventBus: class {
    subscribe(fn: (e: any) => void) { subscribers.push(fn); return () => {} }
    emit(e: any) { subscribers.forEach(fn => fn(e)) }
  }
}))
vi.mock('../orchestrator/runStore', () => ({
  readLastRun: vi.fn(),
  RunStore: class { get runDir() { return '/tmp' } getContext() { return null } setContext() {} appendMessage() {} writeArtifact() { return { path: '/tmp/a', kind: 'file' } } saveState() {} }
}))
vi.mock('../mcp/forgeBridge', () => ({ startBridge: vi.fn(() => Promise.resolve({ socketPath: '/tmp/forge.sock', close: () => Promise.resolve() })) }))
vi.mock('../chat/proposeRun', () => {
  const fn: any = vi.fn(() => Promise.resolve({ approved: true }))
  fn.has = vi.fn(() => false)
  fn.resolve = vi.fn()
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
  readSettings: () => ({ termProxy: '', pinnedWorkspaces: [] }),
  writeSettings: vi.fn(),
  readProjects: () => ({ projects: [] }),
  writeProjects: vi.fn(),
  readWorkflows: () => ({ workflows: [] }),
  writeWorkflows: vi.fn(),
  registerWorkspace: vi.fn(),
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
  readWorkspaceRegistry: () => [],
}))
vi.mock('../workspace/workspaceService', () => ({
  createWorkspace: vi.fn(async () => ({ workspace: { name: 'new' }, startRunOpts: {} })),
  editWorkspace: (args: any) => editWorkspaceMock(args),
}))
vi.mock('../workspace/workspaceSetup', () => ({ runWorkspaceSetup: vi.fn(async () => ({ workspace: { name: 'setup' }, startRunOpts: {} })) }))
vi.mock('../workspace/archiveOps', () => ({ archiveWorkspaceLifecycle: vi.fn(), restoreWorkspaceLifecycle: vi.fn() }))
vi.mock('../workspace/archivedGuard', () => ({ isArchivedWorkspace: vi.fn(() => false) }))
vi.mock('../workspace/deleteWorkspace', () => ({ deleteWorkspace: vi.fn(async () => ({ deleted: true })) }))
vi.mock('../workspace/summarizeWorkspace', () => ({ summarizeWorkspace: vi.fn(async () => 'desc') }))
vi.mock('../workspace/workspaceLifecycle', () => ({ setWorkspaceLifecycle: vi.fn() }))
vi.mock('../plugins/pluginStore', () => ({
  installPlugin: vi.fn(), uninstallPlugin: vi.fn(), setPluginEnabled: vi.fn(), readPlugins: vi.fn(() => []),
}))
vi.mock('../plugins/pluginSchedulerRef', () => ({
  getPluginScheduler: () => ({ snapshot: vi.fn(() => ({ plugins: [], results: {} })), reconcile: vi.fn(), refresh: vi.fn(() => Promise.resolve()) }),
}))
vi.mock('../plugins/officialCatalog', () => ({ listCatalog: () => [], installOfficial: vi.fn() }))
vi.mock('../agents/refreshModels', () => ({ refreshProviderModels: vi.fn() }))

async function invoke(channel: string, broadcast: (ch: string, p: unknown) => void, ...args: unknown[]) {
  const { registerIpc } = await import('./handlers')
  const { ipcMain } = await import('electron') as any
  ;(ipcMain.handle as any).mockClear()
  registerIpc(broadcast, {})
  const call = (ipcMain.handle as any).mock.calls.find((c: any[]) => c[0] === channel)
  if (!call) throw new Error(`No handler for channel: ${channel}`)
  return call[1]({}, ...args)
}

beforeEach(() => {
  vi.resetModules()
  editWorkspaceMock.mockReset()
  editWorkspaceMock.mockResolvedValue({ workspace: { name: 'edited' } })
  subscribers.length = 0
})

describe('CH.workspaceEdit broadcast', () => {
  it('broadcasts workspacesChanged after a successful edit', async () => {
    const sent: [string, unknown][] = []
    const EDIT_ARGS = { path: '/ws/a', opts: { name: 'edited', workflowId: 'standard', stages: [], projects: [] } }
    await invoke(CH.workspaceEdit, (ch, p) => sent.push([ch, p]), EDIT_ARGS)
    expect(sent).toContainEqual([CH.workspacesChanged, {}])
  })
})
