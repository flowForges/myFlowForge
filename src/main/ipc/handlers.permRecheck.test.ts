import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CH } from './channels'

// 权限档在【运行中】切换的即时兑现(2026-08-20)。
//
// 背景:permissionMode 只在进程启动那一刻被翻译成 CLI 沙箱参数(permissionArgs.ts),进程起来后沙箱就钉死了
// —— 所以运行中切换默认要等【下一轮】才生效。唯一还能半途兑现的通道是 CLI 主动升起的确认门:门是我们答的,
// 我们答 allow,CLI 就照做。这里锁住两条路径:
//   ① 门升起时先读一次会话最新的权限档,已是 full → 直接放行,连卡片都不弹;
//   ② 门已经挂着、用户此刻才切到 full → 把该会话所有挂起的确认门就地放行,卡片当场消失。
// 以及一条绝不能破的守卫:带 questions 的门(AskUserQuestion 借 can_use_tool 通道伪装成的「模型在问人」)
// 永远不自动放行 —— 自动 allow 会带空 answers 回去,CLI 直接告诉模型「用户没有回答」。

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
vi.mock('../chat/chatService', () => ({ sendTurn: (...a: any[]) => sendTurnMock(...a), history: vi.fn(() => []) }))
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
  readSettings: () => ({ termProxy: '', pinnedWorkspaces: [], fullAccessAck: {} }),
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

type Confirm = (req: { title: string; where?: string; questions?: unknown[] }) => Promise<unknown>

/**
 * 起一轮真实的 chat turn,把 registerIpc 交给 sendTurn 的 `confirm` 抓出来 —— 这就是 CLI 升门用的那个出口。
 * sendTurn 停在一个永不 resolve 的 promise 上,让门保持挂起(轮次一结束 drainChatGates 会把门 deny 掉)。
 */
async function startTurn(agent = 'claude', requireConfirm = true) {
  vi.resetModules()
  sendTurnMock.mockReset()
  const { registerIpc } = await import('./handlers')
  const { ipcMain } = await import('electron') as any
  ;(ipcMain.handle as any).mockClear()
  const sent: [string, any][] = []
  registerIpc((ch: string, p: unknown) => sent.push([ch, p as any]), {})
  const call = (ch: string) => {
    const c = (ipcMain.handle as any).mock.calls.find((x: any[]) => x[0] === ch)
    if (!c) throw new Error(`No handler for channel: ${ch}`)
    return c[1]
  }
  let confirm: Confirm | null = null
  sendTurnMock.mockImplementation((_p: any, deps: any) => { confirm = deps.confirm; return new Promise(() => {}) })
  call(CH.chatSend)({}, { workspacePath: '/ws/a', sessionId: 's1', agent, agentLabel: agent, model: 'm', text: 'x', attachments: [], permissionMode: sessionState.permissionMode })
  await new Promise(r => setTimeout(r, 0))
  // cursor 这类无沙箱 provider 会先卡在「预授权门」上,sendTurn 压根没跑到 —— 那种用例不需要 confirm。
  if (requireConfirm && !confirm) throw new Error('sendTurn never ran — confirm not captured')
  return { confirm: confirm as unknown as Confirm, sent, call }
}

const requests = (sent: [string, any][]) => sent.filter(([c, p]) => c === CH.chatEvent && p.type === 'confirm-request')
const resolved = (sent: [string, any][]) => sent.filter(([c, p]) => c === CH.chatEvent && p.type === 'confirm-resolved')

beforeEach(() => { sessionState.permissionMode = 'auto' })

describe('确认门升起时重新检查权限档', () => {
  it('auto 档:照常升门,不自动决策', async () => {
    const { confirm, sent } = await startTurn()
    let settled: unknown = undefined
    void confirm({ title: 'Bash 请求执行', where: 'ls' }).then(d => { settled = d })
    await new Promise(r => setTimeout(r, 0))
    expect(requests(sent)).toHaveLength(1)
    expect(settled).toBeUndefined()
  })

  it('★ full 档:直接放行,连 confirm-request 都不广播(卡片根本不弹)', async () => {
    sessionState.permissionMode = 'full'
    const { confirm, sent } = await startTurn()
    await expect(confirm({ title: 'Bash 请求执行', where: 'rm -rf /tmp/x' })).resolves.toBe('allow')
    expect(requests(sent)).toHaveLength(0)
  })

  it('★ full 档:自动放行要在对话里留一行审计痕迹,不能悄悄放行', async () => {
    sessionState.permissionMode = 'full'
    const { confirm, sent } = await startTurn()
    await confirm({ title: 'Bash 请求执行', where: 'ls -la' })
    const notes = sent.filter(([c, p]) => c === CH.chatEvent && p.type === 'done' && typeof p.message?.text === 'string')
    expect(notes.some(([, p]) => p.message.text.includes('完全访问') && p.message.text.includes('ls -la'))).toBe(true)
  })

  it('★★ full 档 + 带 questions 的门:仍然升门 —— 它是模型在问人,自动 allow 会把空答案回给 CLI', async () => {
    sessionState.permissionMode = 'full'
    const { confirm, sent } = await startTurn()
    let settled: unknown = undefined
    void confirm({ title: '选一个', questions: [{ question: '选哪个?', header: 'x', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] }).then(d => { settled = d })
    await new Promise(r => setTimeout(r, 0))
    expect(requests(sent)).toHaveLength(1)
    expect(settled).toBeUndefined()
  })

  it('读的是会话【当前】的档,不是这一轮启动时的档', async () => {
    // 轮次以 auto 起跑(payload.permissionMode='auto'),跑到一半用户切到 full。
    const { confirm, sent, call } = await startTurn()
    await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'full' })
    await expect(confirm({ title: 'Write 请求执行', where: '/etc/hosts' })).resolves.toBe('allow')
    expect(requests(sent)).toHaveLength(0)
  })
})

describe('切到完全访问时排空已挂起的确认门', () => {
  it('★ 门挂着的时候切到 full → 就地放行 + 广播 confirm-resolved(卡片消失)', async () => {
    const { confirm, sent, call } = await startTurn()
    let settled: unknown = undefined
    void confirm({ title: 'Bash 请求执行', where: 'ls' }).then(d => { settled = d })
    await new Promise(r => setTimeout(r, 0))
    expect(requests(sent)).toHaveLength(1)

    await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'full' })
    await new Promise(r => setTimeout(r, 0))
    expect(settled).toBe('allow')
    expect(resolved(sent)).toHaveLength(1)
    expect(resolved(sent)[0][1].id).toBe(requests(sent)[0][1].id)
  })

  it('★★ 排空时同样跳过带 questions 的门', async () => {
    const { confirm, sent, call } = await startTurn()
    let settled: unknown = undefined
    void confirm({ title: '选一个', questions: [{ question: '选哪个?', header: 'x', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] }).then(d => { settled = d })
    await new Promise(r => setTimeout(r, 0))

    await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'full' })
    await new Promise(r => setTimeout(r, 0))
    expect(settled).toBeUndefined()
    expect(resolved(sent)).toHaveLength(0)
  })

  it('切到 readonly / auto:挂起的门原封不动,仍等用户点', async () => {
    for (const mode of ['readonly', 'auto'] as const) {
      sessionState.permissionMode = 'auto'
      const { confirm, sent, call } = await startTurn()
      let settled: unknown = undefined
      void confirm({ title: 'Bash 请求执行', where: 'ls' }).then(d => { settled = d })
      await new Promise(r => setTimeout(r, 0))

      await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode })
      await new Promise(r => setTimeout(r, 0))
      expect(settled, mode).toBeUndefined()
      expect(resolved(sent), mode).toHaveLength(0)
    }
  })

  it('★ 只放行【这个会话】的门 —— 同工作区另一个会话正在等的门不许被顺手放掉', async () => {
    const { confirm, sent, call } = await startTurn()
    // 同一工作区、另一个会话升起的门(用 s2)。
    sendTurnMock.mockImplementation((_p: any, deps: any) => { (globalThis as any).__c2 = deps.confirm; return new Promise(() => {}) })
    call(CH.chatSend)({}, { workspacePath: '/ws/a', sessionId: 's2', agent: 'claude', agentLabel: 'C', model: 'm', text: 'y', attachments: [], permissionMode: 'auto' })
    await new Promise(r => setTimeout(r, 0))
    const confirm2 = (globalThis as any).__c2 as Confirm

    let a: unknown = undefined, b: unknown = undefined
    void confirm({ title: 'A 请求执行', where: 'a' }).then(d => { a = d })
    void confirm2({ title: 'B 请求执行', where: 'b' }).then(d => { b = d })
    await new Promise(r => setTimeout(r, 0))

    await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'full' })
    await new Promise(r => setTimeout(r, 0))
    expect(a).toBe('allow')
    expect(b).toBeUndefined()
  })
})

// ── 运行中改档「本轮不生效」的提示 ──────────────────────────────────────────────────────────
// codex/qoder/antigravity 的权限档就是启动时的沙箱参数(agents/permissionArgs.ts),进程一起来就钉死,
// 而且它们压根不升确认门(codex 的 approval_policy 恒 never,qoder 连 onConfirm 都没有)—— 所以运行中
// 切档对当前这轮零影响。不说一声,用户只会以为「我切了但没反应 = 这功能坏了」。
describe('运行中改档:本轮不生效时要说一声', () => {
  const notes = (sent: [string, any][]) =>
    sent.filter(([c, p]) => c === CH.chatEvent && p.type === 'done' && typeof p.message?.text === 'string')
        .map(([, p]) => p.message.text as string)

  it('★ codex 正在跑时切档 → 提示「下一条消息才生效」,并说清本轮仍按旧档跑', async () => {
    const { sent, call } = await startTurn('codex')
    await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'full' })
    const hint = notes(sent).find(t => t.includes('下一条消息'))
    expect(hint).toBeTruthy()
    expect(hint).toContain('完全访问')       // 切到了什么
    expect(hint).toContain('自动(工作区)')   // 本轮仍按什么跑
  })

  it('★ claude 正在跑时切到完全访问 → 不提示(它当场就兑现了)', async () => {
    const { sent, call } = await startTurn('claude')
    await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'full' })
    expect(notes(sent).some(t => t.includes('下一条消息'))).toBe(false)
  })

  it('★ claude 正在跑时切到只读 → 仍要提示(收紧管不了已经起来的进程)', async () => {
    const { sent, call } = await startTurn('claude')
    await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'readonly' })
    expect(notes(sent).some(t => t.includes('下一条消息'))).toBe(true)
  })

  it('没有轮次在跑的时候切档 → 不提示(本来就是下一轮的事,不用啰嗦)', async () => {
    vi.resetModules()
    const { registerIpc } = await import('./handlers')
    const { ipcMain } = await import('electron') as any
    ;(ipcMain.handle as any).mockClear()
    const sent: [string, any][] = []
    registerIpc((ch: string, p: unknown) => sent.push([ch, p as any]), {})
    const h = (ipcMain.handle as any).mock.calls.find((x: any[]) => x[0] === CH.sessionSetPermission)[1]
    await h({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'full' })
    expect(notes(sent).some(t => t.includes('下一条消息'))).toBe(false)
  })

  it('★ 不吃权限档的 provider(cursor)不提示 —— 说「下一条消息生效」是骗人的,它永远不生效', async () => {
    const { sent, call } = await startTurn('cursor', false)
    await call(CH.sessionSetPermission)({}, { workspacePath: '/ws/a', sessionId: 's1', mode: 'full' })
    console.log('DBG cursor notes:', JSON.stringify(notes(sent)))
    expect(notes(sent).some(t => t.includes('下一条消息'))).toBe(false)
  })
})
