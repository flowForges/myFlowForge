import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CH } from './channels'
import { fakeHost } from '../host/fakeHost'
import { tableCalls } from './testTable'

// 归档 = 只读封存。它自己绝不能起 agent —— 原先归档会在被归档工作区的 cwd 里跑一个一次性 CLI 去生成
// 那行归档描述,于是外部的 agent 监控插件看见「已归档的工作区里有 claude 在执行」并推了通知(而且那个
// 一次性会话超时后也没人 cancel)。这条测试盯住的就是「归档不碰 provider」。

const detect = vi.fn(async () => true)
const chat = vi.fn(() => ({ id: 'x', cancel: vi.fn(), done: Promise.resolve({ ok: true }) }))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {} }))
vi.mock('../run/runStore', () => ({
  RunStore: class { get runDir() { return '/tmp' } getContext() { return null } setContext() {} appendMessage() {} writeArtifact() { return { path: '/tmp/a', kind: 'file' } } saveState() {} }
}))
vi.mock('../mcp/forgeBridge', () => ({ startBridge: vi.fn(() => Promise.resolve({ socketPath: '/tmp/forge.sock', close: () => Promise.resolve() })) }))
vi.mock('../workspace/workspaceList', () => ({ listWorkspaces: vi.fn(() => []) }))
vi.mock('../workspace/workspaceRun', () => ({ workspaceToStartRunOpts: vi.fn() }))
vi.mock('../chat/chatService', () => ({ sendTurn: vi.fn(), history: vi.fn(() => []) }))
vi.mock('../skills/installSkill', () => ({ removeWorkspaceSkill: vi.fn() }))
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
vi.mock('../workspace/workspaceService', () => ({ createWorkspace: vi.fn(), editWorkspace: vi.fn() }))
vi.mock('../workspace/workspaceSetup', () => ({ runWorkspaceSetup: vi.fn() }))
vi.mock('../workspace/archiveOps', () => ({ archiveWorkspaceLifecycle: vi.fn(), restoreWorkspaceLifecycle: vi.fn() }))
vi.mock('../workspace/archivedGuard', () => ({ isArchivedWorkspace: vi.fn(() => false) }))
vi.mock('../workspace/deleteWorkspace', () => ({ deleteWorkspace: vi.fn(async () => ({ deleted: true })) }))
vi.mock('../workspace/workspaceLifecycle', () => ({ setWorkspaceLifecycle: vi.fn() }))
vi.mock('../plugins/pluginStore', () => ({
  installPlugin: vi.fn(), uninstallPlugin: vi.fn(), setPluginEnabled: vi.fn(), readPlugins: vi.fn(() => []),
}))
vi.mock('../plugins/pluginSchedulerRef', () => ({
  getPluginScheduler: () => ({ snapshot: vi.fn(() => ({ plugins: [], results: {} })), reconcile: vi.fn(), refresh: vi.fn(() => Promise.resolve()) }),
}))
vi.mock('../plugins/officialCatalog', () => ({ listCatalog: () => [], installOfficial: vi.fn() }))
vi.mock('../agents/refreshModels', () => ({ refreshProviderModels: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  detect.mockClear()
  chat.mockClear()
})

describe('CH.workspaceArchive', () => {
  it('不起任何 agent(既不 detect 也不 chat)', async () => {
    const { registerIpc } = await import('./handlers')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providers = { claude: { id: 'claude', displayName: 'Claude', detect, chat } } as any
    const calls = tableCalls(registerIpc(() => {}, providers, fakeHost()))
    const call = calls.find(c => c[0] === CH.workspaceArchive) as [string, (e: unknown, p: string) => unknown]
    call[1]({}, '/ws/archived')
    await new Promise(r => setTimeout(r, 0))   // 让 fire-and-forget 的后台链路有机会跑起来

    expect(detect).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
  })
})
