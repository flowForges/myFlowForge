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

beforeEach(() => { session.browserUse = 'ask'; session.permissionMode = 'auto'; session.workflowSession = undefined })

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

/**
 * ★★设计 §4.3:「完全访问」+「每次询问」这个组合 Forge 必须**拒绝**。原来只有 Composer 挡,可上面那三条
 *  发送路一条都不经过 Composer —— 配成 'full' 的阶段 + 会话上的「每次询问」就带着 `--chrome` +
 *  bypassPermissions(0 道门)跑出去了。现在关卡在主进程的 runTurn:三条路(和输入框)全都经
 *  chatQueue 走到它。这里逐条钉住:这一轮**不发**(sendTurn 一次都不调),原因写进会话,
 *  而且**不改**用户落盘的任何一个档。
 */
describe('§4.3 的拒绝在主进程发车处生效 —— 不经输入框的三条路也绕不过去', () => {
  async function bootWithStore() {
    const b = await boot()
    const store: any = await import('../chat/chatStore')
    const sessions: any = await import('../chat/sessionStore')
    store.appendMessage.mockClear()
    return { ...b, store, sessions }
  }
  const notes = (store: any): string[] => store.appendMessage.mock.calls.map((c: any[]) => c[2]?.text as string)
  const flush = () => new Promise(r => setTimeout(r, 0))
  const expectRefused = (store: any, sessions: any) => {
    expect(sendTurnMock).not.toHaveBeenCalled()
    const n = notes(store).find(t => t?.includes('没有发出'))
    expect(n).toBeTruthy()
    expect(n).toContain('完全访问')
    // 不替用户做决定:权限档和浏览器档一个都不许动。
    expect(sessions.setSessionPermission).not.toHaveBeenCalled()
    expect(sessions.setSessionBrowserUse).not.toHaveBeenCalled()
  }

  it('★工作流阶段起手一轮:阶段配成「完全访问」+ 会话「每次询问」→ 拒绝,不带 --chrome 零门跑出去', async () => {
    const { call, store, sessions } = await bootWithStore()
    const wf = chattingWorkflow()
    wf.stages[1].permissionMode = 'full'
    session.workflowSession = wf
    await call(CH.workflowAdvance)({}, { workspacePath: '/ws/a', sessionId: 's1' })
    await flush()
    expectRefused(store, sessions)
  })

  it('★机器人桥:/perm 把会话切到「完全访问」后,载荷里没有档 —— 照样按落盘的档拒绝', async () => {
    const { store, sessions } = await bootWithStore()
    session.permissionMode = 'full'   // 落盘是 full:toolConfirm 会把每道门都自动放行
    botDeps.enqueue({
      workspacePath: '/ws/a', sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code',
      model: 'opus-4.8', text: '去后台改个配置', attachments: [], source: '飞书',
    }, '飞书')
    await flush()
    expectRefused(store, sessions)
  })

  it('★宠物窗(走 chat:send,载荷不带档):会话落盘是「完全访问」→ 拒绝', async () => {
    const { call, store, sessions } = await bootWithStore()
    session.permissionMode = 'full'
    await call(CH.chatSend)({}, {
      workspacePath: '/ws/a', sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code',
      model: 'opus-4.8', text: '帮我看看邮箱', attachments: [], browserUse: 'ask',
    }, '宠物')
    await flush()
    expectRefused(store, sessions)
  })

  it('载荷自己带着「完全访问」(输入框那条路)也在这里拒绝 —— Composer 不再是唯一一道', async () => {
    const { call, store, sessions } = await bootWithStore()
    await call(CH.chatSend)({}, {
      workspacePath: '/ws/a', sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code',
      model: 'opus-4.8', text: 'x', attachments: [], browserUse: 'ask', permissionMode: 'full',
    })
    await flush()
    expectRefused(store, sessions)
  })

  it('拒绝后这条会话的队列不卡住:改掉矛盾再发,照常跑', async () => {
    const { call } = await bootWithStore()
    session.permissionMode = 'full'
    const send = { workspacePath: '/ws/a', sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', attachments: [], browserUse: 'ask' }
    await call(CH.chatSend)({}, { ...send, text: '第一句' })
    await flush()
    expect(sendTurnMock).not.toHaveBeenCalled()
    session.permissionMode = 'auto'
    await call(CH.chatSend)({}, { ...send, text: '第二句' })
    await flush()
    expect(sendTurnMock).toHaveBeenCalledTimes(1)
    expect(lastPayload().text).toBe('第二句')
  })

  it('不冲突的组合照常跑:「完全访问」+「放行」、「完全访问」+ 关', async () => {
    const { call } = await bootWithStore()
    session.permissionMode = 'full'
    const send = { workspacePath: '/ws/a', sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: 'x', attachments: [] }
    await call(CH.chatSend)({}, { ...send, browserUse: 'allow' })
    await flush()
    await call(CH.chatSend)({}, { ...send })
    await flush()
    expect(sendTurnMock).toHaveBeenCalledTimes(2)
  })
})
