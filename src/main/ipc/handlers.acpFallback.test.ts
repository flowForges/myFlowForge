import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CH } from './channels'
import { fakeHost } from '../host/fakeHost'
import { tableCalls } from './testTable'
import { makeGeminiProvider } from '../agents/providers/gemini'
import { fakeTransport } from '../agents/acp/acpTestKit'
import { resetAcpAvailability } from '../agents/acp/acpAvailability'
import type { AgentProvider } from '../agents/types'

// ACP provider(gemini/qwen/copilot)握手没成、要回落到 run() 时的「完全访问」授权(final review Important 1)。
//
// 首轮 ACP 状态未知 → 按「有门」算 → 发车前的预授权门不弹。握手失败后 run() 是 `--approval-mode yolo` /
// `--allow-all-tools`,没有门 —— 所以回落之前必须补问一次(beforeFallback);一次性调用(上下文总结等)
// 没人能答,干脆不回落,按「这个 provider 没有 chat()」处理。

const acked = { value: false }
const sessionState: { permissionMode?: 'readonly' | 'auto' | 'full' } = { permissionMode: 'auto' }
const sessionFile = () => ({ sessions: [{ id: 's1', title: '新会话', mode: 'chat' as const, createdAt: 0, permissionMode: sessionState.permissionMode }], activeSessionId: 's1' })

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

const sendTurnMock = vi.fn()
const historyMsgs: { who: string; text: string }[] = []
vi.mock('../chat/chatService', () => ({ sendTurn: (...a: any[]) => sendTurnMock(...a), history: vi.fn(() => historyMsgs) }))
vi.mock('../skills/installSkill', () => ({ removeWorkspaceSkill: vi.fn() }))
vi.mock('../chat/chatStore', () => ({ appendMessage: vi.fn(), readMessages: vi.fn(() => []), sessionLastMessageMtime: vi.fn(() => undefined) }))
vi.mock('../chat/delegate', () => ({ makeRunDelegate: () => vi.fn(), cancelWorkspaceDelegates: vi.fn() }))
vi.mock('../chat/sessionStore', () => ({
  readSessions: vi.fn(() => sessionFile()),
  getSession: vi.fn((_ws: string, id: string) => sessionFile().sessions.find(s => s.id === id)),
  setSessionPermission: vi.fn((_ws: string, _id: string, mode: any) => { sessionState.permissionMode = mode; return sessionFile() }),
  newSession: vi.fn(), switchSession: vi.fn(), closeSession: vi.fn(), renameSession: vi.fn(),
  setSessionMode: vi.fn(), setSessionModel: vi.fn(), continueFrom: vi.fn(), setSessionWorkflow: vi.fn(),
  autoNameIfDefault: vi.fn(),
}))
vi.mock('../config/store', () => ({
  readSettings: () => ({ agentProxy: '', appProxy: '', pinnedWorkspaces: [], fullAccessAck: {} }),
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
  // ★ 少了这两个,cursor 这类无沙箱 provider 的「预授权门」会在 runTurn 里抛 TypeError,轮次当场夭折、
  //   lane.running 被清掉 —— 于是「不该提示」的用例变成【假绿】(不是因为过滤生效,而是因为压根没在跑)。
  isFullAccessAcked: () => acked.value,
  ackFullAccess: vi.fn(() => { acked.value = true }),
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


const refusing = () => fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('unknown method') })).transport

async function setup(providers: Record<string, AgentProvider> = {}) {
  vi.resetModules()
  sendTurnMock.mockReset()
  const { registerIpc } = await import('./handlers')
  const sent: [string, any][] = []
  const calls = tableCalls(registerIpc((ch: string, p: unknown) => sent.push([ch, p as any]), providers, fakeHost()))
  const call = (ch: string) => {
    const c = calls.find((x: any[]) => x[0] === ch)
    if (!c) throw new Error(`No handler for channel: ${ch}`)
    return c[1]
  }
  return { sent, call }
}

const events = (sent: [string, any][], type: string) => sent.filter(([c, p]) => c === CH.chatEvent && p.type === type).map(([, p]) => p)
const notes = (sent: [string, any][]) => events(sent, 'done').map((p) => String(p.message?.text ?? ''))
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  sessionState.permissionMode = 'auto'
  acked.value = false
  historyMsgs.length = 0
  resetAcpAvailability()
})

describe('交互聊天:回落到 run() 之前补问「完全访问」', () => {
  async function turn(permissionMode: 'readonly' | 'auto' | 'full' = 'auto') {
    const s = await setup()
    let deps: any = null
    sendTurnMock.mockImplementation((_p: any, d: any) => { deps = d; return new Promise(() => {}) })
    s.call(CH.chatSend)({}, { workspacePath: '/ws/a', sessionId: 's1', agent: 'gemini', agentLabel: 'gemini', model: 'm', text: 'x', attachments: [], permissionMode })
    await tick()
    if (!deps) throw new Error('sendTurn never ran')
    return { ...s, deps }
  }

  it('首轮 ACP 状态未知:发车前不弹,但把关口交给 sendTurn', async () => {
    const { sent, deps } = await turn()
    expect(events(sent, 'confirm-request')).toHaveLength(0)
    expect(typeof deps.beforeFallback).toBe('function')
  })

  it('★★关口:弹同一张授权卡;拒绝 → 留「已取消」那句、答 false', async () => {
    const { sent, deps, call } = await turn()
    const answer = deps.beforeFallback() as Promise<boolean>
    await tick()
    const [req] = events(sent, 'confirm-request')
    expect(req.title).toContain('无法逐操作确认')
    await call(CH.chatResolve)({}, { id: req.id, decision: 'deny', workspacePath: '/ws/a' })
    await expect(answer).resolves.toBe(false)
    expect(notes(sent).some((t) => t.includes('已取消') && t.includes('未授权'))).toBe(true)
    expect(acked.value).toBe(false)
  })

  it('关口:同意 → 记住授权、答 true', async () => {
    const { sent, deps, call } = await turn()
    const answer = deps.beforeFallback() as Promise<boolean>
    await tick()
    const [req] = events(sent, 'confirm-request')
    await call(CH.chatResolve)({}, { id: req.id, decision: 'allow', workspacePath: '/ws/a' })
    await expect(answer).resolves.toBe(true)
    expect(acked.value).toBe(true)
  })

  it('已经授权过 / 这一轮就是完全访问 → 不弹卡,直接答 true', async () => {
    acked.value = true
    const a = await turn()
    await expect(a.deps.beforeFallback()).resolves.toBe(true)
    expect(events(a.sent, 'confirm-request')).toHaveLength(0)
    acked.value = false
    const b = await turn('full')
    await expect(b.deps.beforeFallback()).resolves.toBe(true)
    expect(events(b.sent, 'confirm-request')).toHaveLength(0)
  })
})

describe('发车前的「完全访问」预授权门:只读档且 provider 硬执行只读时不弹', () => {
  async function send(agent: string, permissionMode: 'readonly' | 'auto') {
    const s = await setup()
    let ran = false
    sendTurnMock.mockImplementation(() => { ran = true; return new Promise(() => {}) })
    s.call(CH.chatSend)({}, { workspacePath: '/ws/a', sessionId: 's1', agent, agentLabel: agent, model: 'm', text: 'x', attachments: [], permissionMode })
    await tick(); await tick()
    return { ...s, ran: () => ran }
  }
  it.each(['pi', 'opencode', 'trae', 'kimi'])('%s readonly → 不弹卡,直接跑', async (agent) => {
    const r = await send(agent, 'readonly')
    expect(events(r.sent, 'confirm-request')).toHaveLength(0)
    expect(r.ran()).toBe(true)
  })
  it('pi auto → 照旧弹卡', async () => {
    const r = await send('pi', 'auto')
    expect(events(r.sent, 'confirm-request')).toHaveLength(1)
    expect(r.ran()).toBe(false)
  })
  it('cursor readonly → 照旧弹卡(它的只读不是硬限制)', async () => {
    const r = await send('cursor', 'readonly')
    expect(events(r.sent, 'confirm-request')).toHaveLength(1)
  })
})

describe('一次性调用:讲不了 ACP 时不回落,和「没有 chat()」一样', () => {
  function oldGemini() {
    const p = makeGeminiProvider({ bin: 'gemini-old', defaultModels: [], acp: { open: refusing } })
    const run = vi.spyOn(p, 'run')
    return { p, run }
  }

  it('切换总结:不跑 run(),什么都不出现(不挂占位、不落「未能生成」)', async () => {
    historyMsgs.push({ who: 'user', text: '做个登录页' })
    const { p, run } = oldGemini()
    const { sent, call } = await setup({ gemini: p })
    await call(CH.chatSwitchSummary)({}, { workspacePath: '/ws/a', sessionId: 's1', toAgent: 'gemini', model: 'm' })
    expect(run).not.toHaveBeenCalled()
    expect(events(sent, 'assistant-start')).toHaveLength(0)
    expect(events(sent, 'done')).toHaveLength(0)
  })

  it('需求总结:不跑 run(),返回 ""(渲染端退回原始对话摘录)', async () => {
    historyMsgs.push({ who: 'user', text: '做个登录页' })
    const { p, run } = oldGemini()
    const { call } = await setup({ gemini: p })
    await expect(call(CH.chatSummarizeRequirement)({}, { workspacePath: '/ws/a', sessionId: 's1', agent: 'gemini', model: 'm' })).resolves.toBe('')
    expect(run).not.toHaveBeenCalled()
  })
})
