import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CH } from './channels'
import { fakeHost } from '../host/fakeHost'
import { tableCalls } from './testTable'
import type { WorkflowSessionState } from '@shared/workflowSession'

/**
 * 浏览器开关是**会话级**设置,可有三条发送路不是用户在输入框里敲出来的,载荷里压根没有它:
 * ① 对话式工作流进入某阶段时的「起手一轮」、② 机器人桥(飞书/TG/钉钉)、③ 宠物窗(在渲染进程,
 * 见 PetApp.tsx)。
 *
 * ★★不补的后果是**同一个会话里能力时有时无**:阶段起手那一轮跑 `--no-chrome`,agent 说它打不开
 *  页面;用户紧接着自己敲的那句却带着 `--chrome`。方向上是安全的(默认关),但用户看到的是「这开关
 *  到底有没有用」—— 比干脆没有这个功能更难理解。所以这里钉住主进程这两条:都要从**落盘的会话**读。
 */

const session: any = {
  id: 's1', title: '新会话', mode: 'chat', createdAt: 0,
  permissionMode: 'auto',
  browserUse: 'ask',
}
const sessionFile = () => ({ sessions: [session], activeSessionId: 's1' })

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {}, app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp' } }))
vi.mock('../update/updateChecker', () => ({
  createUpdateChecker: () => ({ start: vi.fn(), stop: vi.fn(), check: vi.fn(async () => {}), current: () => null }),
}))
vi.mock('../run/runStore', () => ({
  RunStore: class { get runDir() { return '/tmp' } getContext() { return null } setContext() {} appendMessage() {} writeArtifact() { return { path: '/tmp/a', kind: 'file' } } saveState() {} }
}))
vi.mock('../mcp/forgeBridge', () => ({ startBridge: vi.fn(() => Promise.resolve({ socketPath: '/tmp/forge.sock', close: () => Promise.resolve() })) }))
vi.mock('../workspace/workspaceList', () => ({ listWorkspaces: vi.fn(() => []) }))
vi.mock('../workspace/workspaceRun', () => ({ workspaceToStartRunOpts: vi.fn() }))

// 机器人桥:把 registerIpc 注入的那套 deps 抓出来,好在用例里直接走它的 enqueue 这条路。
const botDeps: any = {}
vi.mock('../bot/botBridge', () => ({
  botBridge: {
    attach: (d: any) => Object.assign(botDeps, d),
    observe: vi.fn(), getStatuses: () => [], connect: vi.fn(), disconnect: vi.fn(),
  },
  genPairing: () => 'PAIR',
}))

const sendTurnMock = vi.fn()
vi.mock('../chat/chatService', () => ({ sendTurn: (...a: any[]) => sendTurnMock(...a), history: vi.fn(() => []) }))
vi.mock('../skills/installSkill', () => ({ removeWorkspaceSkill: vi.fn() }))
vi.mock('../chat/chatStore', () => ({ appendMessage: vi.fn(), readMessages: vi.fn(() => []), sessionLastMessageMtime: vi.fn(() => undefined) }))
vi.mock('../chat/delegate', () => ({ makeRunDelegate: () => vi.fn(), cancelWorkspaceDelegates: vi.fn() }))
vi.mock('../chat/sessionStore', () => ({
  readSessions: vi.fn(() => sessionFile()),
  getSession: vi.fn((_ws: string, id: string) => (id === 's1' ? session : undefined)),
  setSessionPermission: vi.fn(() => sessionFile()),
  setSessionWorkflow: vi.fn(() => sessionFile()),
  newSession: vi.fn(() => sessionFile()), switchSession: vi.fn(() => sessionFile()),
  closeSession: vi.fn(() => sessionFile()), renameSession: vi.fn(() => sessionFile()),
  setSessionMode: vi.fn(() => sessionFile()), setSessionModel: vi.fn(() => sessionFile()),
  setSessionBrowserUse: vi.fn(() => sessionFile()),
  continueFrom: vi.fn(() => sessionFile()),
  autoNameIfDefault: vi.fn(),
}))
vi.mock('../config/store', () => ({
  readSettings: () => ({ agentProxy: '', appProxy: '', pinnedWorkspaces: [], fullAccessAck: {}, botBridge: {} }),
  writeSettings: vi.fn(),
  readProjects: () => ({ projects: [] }),
  writeProjects: vi.fn(),
  readWorkflows: () => ({ workflows: [] }),
  writeWorkflows: vi.fn(),
  readCustomStages: () => ({ stages: [] }),
  upsertCustomStage: vi.fn(() => []),
  deleteCustomStage: vi.fn(() => []),
  registerWorkspace: vi.fn(),
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
  readWorkspaceRegistry: () => [],
  readAgentsConfig: () => ({ providers: [], custom: [] }),
  isFullAccessAcked: () => false,
  ackFullAccess: vi.fn(),
}))
vi.mock('../workspace/workspaceService', () => ({ createWorkspace: vi.fn(), editWorkspace: vi.fn() }))
vi.mock('../workspace/workspaceSetup', () => ({ runWorkspaceSetup: vi.fn() }))
vi.mock('../workspace/archiveOps', () => ({ archiveWorkspaceLifecycle: vi.fn(), restoreWorkspaceLifecycle: vi.fn() }))
vi.mock('../workspace/archivedGuard', () => ({ isArchivedWorkspace: vi.fn(() => false) }))
vi.mock('../workspace/deleteWorkspace', () => ({ deleteWorkspace: vi.fn() }))
vi.mock('../workspace/workspaceLifecycle', () => ({ setWorkspaceLifecycle: vi.fn() }))
vi.mock('../plugins/pluginStore', () => ({ installPlugin: vi.fn(), uninstallPlugin: vi.fn(), setPluginEnabled: vi.fn(), readPlugins: vi.fn(() => []) }))
vi.mock('../plugins/pluginSchedulerRef', () => ({
  getPluginScheduler: () => ({ snapshot: vi.fn(() => ({ plugins: [], results: {} })), reconcile: vi.fn(), refresh: vi.fn(() => Promise.resolve()) }),
}))
vi.mock('../plugins/officialCatalog', () => ({ listCatalog: () => [], installOfficial: vi.fn() }))
vi.mock('../agents/refreshModels', () => ({ refreshProviderModels: vi.fn() }))

// 两个对话阶段(scope:'root'),从 0 推进到 1 仍是 chatting —— 正好触发阶段起手那一轮。
const chattingWorkflow = (): WorkflowSessionState => ({
  flowId: 'f1', flowName: '需求开发',
  stages: [
    { key: 'a', name: '需求澄清', provider: 'claude', model: 'opus-4.8', scope: 'root' },
    { key: 'b', name: '技术方案', provider: 'claude', model: 'opus-4.8', scope: 'root' },
  ],
  currentIndex: 0, phase: 'chatting', projects: [],
})

async function boot() {
  vi.resetModules()
  sendTurnMock.mockReset().mockResolvedValue(undefined)
  for (const k of Object.keys(botDeps)) delete botDeps[k]
  const { registerIpc } = await import('./handlers')
  const calls = tableCalls(registerIpc(() => {}, {}, fakeHost()))
  const call = (ch: string) => {
    const c = calls.find((x: any[]) => x[0] === ch)
    if (!c) throw new Error(`No handler for channel: ${ch}`)
    return c[1]
  }
  return { call }
}

const lastPayload = () => sendTurnMock.mock.calls.at(-1)?.[0]

beforeEach(() => { session.browserUse = 'ask'; session.workflowSession = undefined })

describe('不经输入框的发送路也要带上会话的浏览器开关', () => {
  it('★工作流阶段的「起手一轮」:从落盘会话读,不再默默跑 --no-chrome', async () => {
    const { call } = await boot()
    session.workflowSession = chattingWorkflow()
    await call(CH.workflowAdvance)({}, { workspacePath: '/ws/a', sessionId: 's1' })
    await new Promise(r => setTimeout(r, 0))
    expect(sendTurnMock).toHaveBeenCalledTimes(1)
    expect(lastPayload().text).toContain('技术方案')
    expect(lastPayload().browserUse).toBe('ask')
  })

  it('工作流起手一轮:会话没开浏览器时就是 off(默认关这条约束不动)', async () => {
    const { call } = await boot()
    session.browserUse = undefined
    session.workflowSession = chattingWorkflow()
    await call(CH.workflowAdvance)({}, { workspacePath: '/ws/a', sessionId: 's1' })
    await new Promise(r => setTimeout(r, 0))
    expect(lastPayload().browserUse).toBeUndefined()   // 下游 claude.ts 对 undefined 显式传 --no-chrome
  })

  it('★机器人桥(飞书/TG):桥的载荷里没有这个字段,主进程要替它从会话补上', async () => {
    await boot()
    session.browserUse = 'allow'
    botDeps.enqueue({
      workspacePath: '/ws/a', sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code',
      model: 'opus-4.8', text: '去看一下线上页面', attachments: [], source: '飞书',
    }, '飞书')
    await new Promise(r => setTimeout(r, 0))
    expect(sendTurnMock).toHaveBeenCalledTimes(1)
    expect(lastPayload().browserUse).toBe('allow')
  })
})
