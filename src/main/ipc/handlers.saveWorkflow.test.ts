import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CH } from './channels'
import { fakeHost } from '../host/fakeHost'
import { tableCalls } from './testTable'
import type { Workspace } from '../config/schema'

/**
 * 手机端工作流编辑器的**往返**验证:存一条回去,再用启动屏那条通道读回来。
 *
 * ★★为什么非要往返不可:`editWorkflows.ts` 的单测只证明了那个纯函数算得对。
 *  真正会出事的是**接线** —— 载荷形状对不上、没落盘、或者落盘了但 `run2:launch-info`
 *  (启动屏和电脑端启动门共用的那一条)读的是另一份。这几种都长着「单测全绿、手机上点了没变化」
 *  这一张脸,而那正是这个项目栽过好几次的地方。
 */

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
vi.mock('../workspace/workspaceService', () => ({ createWorkspace: vi.fn(), editWorkspace: vi.fn() }))
vi.mock('../workspace/workspaceSetup', () => ({ runWorkspaceSetup: vi.fn() }))
vi.mock('../workspace/archiveOps', () => ({ archiveWorkspaceLifecycle: vi.fn(), restoreWorkspaceLifecycle: vi.fn() }))
vi.mock('../workspace/deleteWorkspace', () => ({ deleteWorkspace: vi.fn() }))
vi.mock('../workspace/workspaceLifecycle', () => ({ setWorkspaceLifecycle: vi.fn() }))
vi.mock('../plugins/pluginStore', () => ({
  installPlugin: vi.fn(), uninstallPlugin: vi.fn(), setPluginEnabled: vi.fn(), readPlugins: vi.fn(() => []),
}))
vi.mock('../plugins/pluginSchedulerRef', () => ({
  getPluginScheduler: () => ({ snapshot: vi.fn(() => ({ plugins: [], results: {} })), reconcile: vi.fn(), refresh: vi.fn(() => Promise.resolve()) }),
}))
vi.mock('../plugins/officialCatalog', () => ({ listCatalog: () => [], installOfficial: vi.fn() }))
vi.mock('../agents/refreshModels', () => ({ refreshProviderModels: vi.fn() }))
vi.mock('../workspace/archivedGuard', () => ({ isArchivedWorkspace: vi.fn(() => false) }))

// 这份「盘」就是一个变量:落盘/读回都走它,于是往返是真的往返,不是各读各的 mock。
const DISK: { ws: Workspace | null } = { ws: null }
vi.mock('../config/store', () => ({
  readSettings: () => ({ termProxy: '', pinnedWorkspaces: [] }),
  writeSettings: vi.fn(),
  readProjects: () => ({ projects: [] }),
  writeProjects: vi.fn(),
  readWorkflows: () => ({ workflows: [{
    id: 'standard', name: '标准工作流', plugins: [], stagePrompts: { develop: '小步提交' },
    stages: [
      { key: 'requirement', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
      { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
    ],
  }] }),
  writeWorkflows: vi.fn(),
  readCustomStages: () => ({ stages: [] }),
  registerWorkspace: vi.fn(),
  unregisterWorkspace: vi.fn(),
  readWorkspace: vi.fn(() => DISK.ws),
  writeWorkspace: vi.fn((ws: Workspace) => { DISK.ws = ws }),
  readWorkspaceRegistry: () => [],
  readHookLibrary: () => ({ hooks: [] }),
  writeHookLibrary: vi.fn(),
  upsertCustomStage: vi.fn(), deleteCustomStage: vi.fn(), upsertProject: vi.fn(),
  setProjectDefaultBranch: vi.fn(), setProjectAlias: vi.fn(),
  readAgentsConfig: () => ({ providers: [], custom: [] }),
  writeAgentsConfig: vi.fn(), setStageModel: vi.fn(),
  isFullAccessAcked: () => true, ackFullAccess: vi.fn(),
}))

const WS = '/ws/a'
const baseWs = (): Workspace => ({
  name: 'a', path: WS, workflowId: '', stages: [], projects: [], status: 'idle', plugins: [], stepPlugins: [],
  workflows: [
    { id: 'light', name: '轻量', stages: [
      { key: 'requirement', provider: 'claude', model: 'opus-4.8', prompt: '别改数据库' },
      { key: 'develop', provider: 'codex', model: 'gpt-5' },
    ] },
    { id: 'full', name: '完整', stages: [{ key: 'develop', provider: 'codex', model: 'gpt-5' }] },
  ],
})

async function table() {
  const { registerIpc } = await import('./handlers')
  const calls = tableCalls(registerIpc((ch: string, p: unknown) => { broadcasts.push([ch, p]) }, {}, fakeHost()))
  return (channel: string, ...args: unknown[]) => {
    const call = calls.find((c: unknown[]) => c[0] === channel)
    if (!call) throw new Error(`No handler for channel: ${channel}`)
    return (call[1] as (e: unknown, ...a: unknown[]) => unknown)({}, ...args)
  }
}
const broadcasts: [string, unknown][] = []

beforeEach(() => {
  vi.resetModules()
  broadcasts.length = 0
  DISK.ws = baseWs()
})

describe('手机端改工作流 → 启动屏读回来', () => {
  it('★删掉一个阶段:同一条 run2:launch-info 通道立刻看到删掉后的流程', async () => {
    const call = await table()
    await call(CH.workspaceSaveWorkflow, {
      workspacePath: WS,
      workflow: { id: 'light', name: '轻量', stages: [{ key: 'develop', provider: 'codex', model: 'gpt-5', gate: false }] },
    })
    const info = (await call(CH.run2LaunchInfo, { workspacePath: WS })) as { workflows: { id: string; stages: { key: string }[] }[] }
    expect(info.workflows.find((w) => w.id === 'light')!.stages.map((s) => s.key)).toEqual(['develop'])
  })

  it('★手机没发的字段一个都没丢:提示词还在盘上', async () => {
    const call = await table()
    await call(CH.workspaceSaveWorkflow, {
      workspacePath: WS,
      workflow: { id: 'light', name: '轻量', stages: [
        { key: 'develop', provider: 'codex', model: 'gpt-5', gate: false },
        { key: 'requirement', provider: 'claude', model: 'opus-4.8', gate: true },
      ] },
    })
    const stages = DISK.ws!.workflows.find((w) => w.id === 'light')!.stages
    expect(stages.map((s) => s.key)).toEqual(['develop', 'requirement'])
    expect(stages[1].prompt).toBe('别改数据库')
    expect(stages[1].gate).toBe(true)
  })

  it('新建一条:回传服务端生成的 id,启动屏据此选中它', async () => {
    const call = await table()
    const r = (await call(CH.workspaceSaveWorkflow, {
      workspacePath: WS,
      workflow: { id: '', name: 'hotfix', stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }] },
    })) as { id: string }
    expect(r.id).toBe('hotfix')
    const info = (await call(CH.run2LaunchInfo, { workspacePath: WS })) as { workflows: { id: string }[] }
    expect(info.workflows.map((w) => w.id)).toEqual(['light', 'full', 'hotfix'])
  })

  it('删一条', async () => {
    const call = await table()
    await call(CH.workspaceDeleteWorkflow, { workspacePath: WS, workflowId: 'full' })
    expect(DISK.ws!.workflows.map((w) => w.id)).toEqual(['light'])
  })

  it('★两条写路径都要广播 workspaces:changed —— 不广播的话电脑端那一侧要等到下次手动刷新', async () => {
    const call = await table()
    await call(CH.workspaceSaveWorkflow, { workspacePath: WS, workflow: { id: 'light', name: '轻量', stages: [{ key: 'develop', provider: 'c', model: 'm' }] } })
    await call(CH.workspaceDeleteWorkflow, { workspacePath: WS, workflowId: 'full' })
    expect(broadcasts.filter(([ch]) => ch === CH.workspacesChanged).length).toBe(2)
  })

  it('阶段清单:内置五个 + 默认代理来自全局模板', async () => {
    const call = await table()
    const cat = (await call(CH.workflowStageCatalog)) as { builtin: { key: string; provider: string }[]; custom: unknown[] }
    expect(cat.builtin.map((s) => s.key)).toEqual(['requirement', 'design', 'develop', 'test', 'review'])
    expect(cat.builtin.find((s) => s.key === 'develop')!.provider).toBe('claude')
    expect(cat.custom).toEqual([])
  })

  it('工作区不存在时明确报错,而不是静默什么也不做', async () => {
    DISK.ws = null
    const call = await table()
    // 同步抛(handler 不是 async),所以这儿不能用 rejects —— 用 rejects 的话断言本身会先炸。
    expect(() => call(CH.workspaceSaveWorkflow, { workspacePath: WS, workflow: { id: '', name: 'x', stages: [{ key: 'develop', provider: 'c', model: 'm' }] } }))
      .toThrow('工作区不存在')
  })
})
